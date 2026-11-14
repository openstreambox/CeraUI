#!/usr/bin/env python3

import argparse
import re
import subprocess
import sys
from pathlib import Path
from xml.etree import ElementTree

import yaml


class BuildError(Exception):
    pass


class StrictLoader(yaml.SafeLoader):
    def compose_node(self, parent, index):
        event = self.peek_event()
        if isinstance(event, yaml.AliasEvent) or getattr(event, 'anchor', None):
            raise BuildError('YAML anchors and aliases are not supported')
        return super().compose_node(parent, index)

    def construct_mapping(self, node, deep=False):
        result = {}
        for key_node, value_node in node.value:
            if key_node.tag != 'tag:yaml.org,2002:str':
                raise BuildError('Rule keys must be strings')
            key = self.construct_object(key_node, deep=deep)
            if key in result:
                raise BuildError(f'Duplicate rule key: {key}')
            result[key] = self.construct_object(value_node, deep=deep)
        return result


def comparable(attributes):
    result = dict(attributes)
    if 'type' in result:
        result['type'] = tuple(sorted(set(result['type'].split(','))))
    return tuple(sorted(result.items()))


def deduplicate(rows):
    unique = {}
    for attributes in rows:
        unique.setdefault(comparable(attributes), attributes)
    return list(unique.values())


def read_apns(path):
    content = path.read_bytes()
    if re.search(rb'<!\s*(?:DOCTYPE|ENTITY)\b', content, re.IGNORECASE):
        raise BuildError(f'{path.name}: DTDs and entities are not supported')
    root = ElementTree.fromstring(content)
    if root.tag != 'apns' or set(root.attrib) != {'version'}:
        raise BuildError(f'{path.name}: expected <apns version="...">')
    if (root.text or '').strip():
        raise BuildError(f'{path.name}: unexpected root text')
    for element in root:
        if (
            element.tag != 'apn'
            or len(element)
            or (element.text or '').strip()
            or (element.tail or '').strip()
        ):
            raise BuildError(f'{path.name}: unsupported APN structure')
    return root.get('version'), [dict(element.attrib) for element in root]


def serialize(version, rows):
    root = ElementTree.Element('apns', {'version': version})
    for attributes in rows:
        attributes = {
            key: value.replace('\r', '&#13;')
            for key, value in attributes.items()
        }
        ElementTree.SubElement(root, 'apn', attributes)

    if len(root):
        root.text = '\n    '
        for element in root[:-1]:
            element.tail = '\n    '
        root[-1].tail = '\n'

    xml = ElementTree.tostring(root, encoding='utf-8')
    xml = xml.replace(b'&amp;#13;', b'&#13;')

    return (
        b'<?xml version="1.0" encoding="utf-8"?>\n'
        b'<!--\n'
        b'    SPDX-FileCopyrightText: Google Inc\n'
        b'    SPDX-FileCopyrightText: The LineageOS Project\n'
        b'    SPDX-License-Identifier: Apache-2.0\n'
        b'-->\n' + xml + b'\n'
    )


def validate(content, args, label):
    result = subprocess.run(
        [args.xmllint, '--nonet', '--noout', '--schema', str(args.schema), '-'],
        input=content,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode:
        raise BuildError(f'{label}: APNs fail schema validation')


def load_config(path, known_attributes):
    try:
        config = yaml.load(path.read_bytes(), Loader=StrictLoader)
    except yaml.YAMLError as error:
        raise BuildError(f'{path.name}: invalid YAML') from error
    if not isinstance(config, dict) or set(config) != {'excludes', 'overrides'}:
        raise BuildError('Expected build-time exclude/override rules')
    for group, fields in (
        ('excludes', {'match'}),
        ('overrides', {'match', 'set'}),
    ):
        if not isinstance(config[group], list):
            raise BuildError(f'{group}: expected a list')
        for number, rule in enumerate(config[group], 1):
            label = f'{group}[{number}]'
            if not isinstance(rule, dict) or set(rule) != fields:
                raise BuildError(f'{label}: unexpected rule fields')
            for field, attributes in rule.items():
                if not isinstance(attributes, dict) or not attributes:
                    raise BuildError(
                        f'{label}.{field}: expected nonempty attributes'
                    )
                if set(attributes) - known_attributes:
                    raise BuildError(f'{label}.{field}: unknown APN attribute')
                for key, value in attributes.items():
                    if key == 'type' and isinstance(value, list):
                        if not value or not all(
                            isinstance(item, str) for item in value
                        ):
                            raise BuildError(
                                f'{label}.{field}: invalid type list'
                            )
                        attributes[key] = ','.join(value)
                    elif value is not None and not isinstance(value, str):
                        raise BuildError(
                            f'{label}.{field}: values must be strings or null'
                        )
    return config


def matches(attributes, conditions):
    for key, value in conditions.items():
        if key == 'type' and value is not None:
            actual = attributes.get(key)
            if actual is None or set(actual.split(',')) != set(
                value.split(',')
            ):
                return False
        elif attributes.get(key) != value:
            return False
    return True


def apply_rules(source, config):
    targets = {}
    for group in ('excludes', 'overrides'):
        for number, rule in enumerate(config[group], 1):
            label = f'{group}[{number}]'
            found = [
                identity
                for identity, attrs in enumerate(source)
                if matches(attrs, rule['match'])
            ]
            if len(found) != 1:
                raise BuildError(
                    f'{label}: matched {len(found)} upstream APNs; expected one'
                )
            identity = found[0]
            if identity in targets:
                raise BuildError(
                    f'{label}: target already used by {targets[identity][0]}'
                )
            targets[identity] = (label, rule.get('set'))
    result = []
    for identity, attrs in enumerate(source):
        attributes = dict(attrs)
        if identity in targets:
            changes = targets[identity][1]
            if changes is None:
                continue
            for key, value in changes.items():
                if value is None:
                    attributes.pop(key, None)
                else:
                    attributes[key] = value
        result.append(attributes)
    return result


def build(args):
    version, upstream = read_apns(args.source)
    local_rows = []
    for path in sorted(args.local, key=lambda path: path.name):
        local_version, rows = read_apns(path)
        if local_version != version:
            raise BuildError(f'{path.name}: root version differs from upstream')
        local_rows.extend(rows)
    validate(serialize(version, upstream + local_rows), args, 'Inputs')
    schema = ElementTree.parse(args.schema)
    namespace = '{http://www.w3.org/2001/XMLSchema}'
    known_attributes = {
        element.get('name')
        for element in schema.findall(
            f'.//{namespace}complexType[@name="apn"]/{namespace}attribute'
        )
    }
    config = load_config(args.config, known_attributes)
    source = apply_rules(deduplicate(upstream), config)
    content = serialize(version, deduplicate(source + local_rows))
    validate(content, args, 'Merged output')
    sys.stdout.buffer.write(content)


def main():
    parser = argparse.ArgumentParser(
        description='Merge upstream APNs with local supplements at build time.'
    )
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--schema', required=True, type=Path)
    parser.add_argument('--xmllint', default='xmllint')
    parser.add_argument('local', nargs='*', type=Path)
    args = parser.parse_args()
    try:
        build(args)
    except (BuildError, OSError, ElementTree.ParseError, ValueError) as error:
        print(f'APN build failed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
