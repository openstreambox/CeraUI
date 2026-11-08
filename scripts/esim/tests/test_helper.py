import copy
import contextlib
import io
import json
import tempfile
from unittest.mock import patch
import importlib.machinery
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[3] / 'apps/backend/ceralive-esim-helper'
loader = importlib.machinery.SourceFileLoader('esim_helper', str(path))
spec = importlib.util.spec_from_loader(loader.name, loader)
helper = importlib.util.module_from_spec(spec)
loader.exec_module(helper)
EID = '0' * 32
PROFILES = [dict(iccid='0' * 19, profileState='disabled', profileName='Example', serviceProviderName='Test')]


class FakeSession(helper.Session):
    def __init__(self):
        super().__init__(dict(eid=EID, backend='at_csim', port='/dev/ttyUSB0'))
        self.rows = copy.deepcopy(PROFILES)
        self.calls = []
        self.fail = False

    def profiles(self):
        return self.rows

    def lpac(self, *args, data=None):
        self.calls.append((args, data))
        if args == ('notification', 'list'):
            return []
        if self.fail:
            raise ValueError('private error')
        if args[:2] == ('profile', 'download'):
            self.rows.append(dict(iccid='1' * 19, profileState='disabled', profileName='New'))
        elif args[:2] == ('profile', 'enable'):
            self.rows[0]['profileState'] = 'enabled'
        elif args[:2] == ('profile', 'disable'):
            self.rows[0]['profileState'] = 'disabled'
        elif args[:2] == ('profile', 'delete'):
            self.rows.clear()


class HelperTests(unittest.TestCase):
    def request(self, action, session):
        state = helper.snapshot(EID, session.rows)
        return dict(action=action, snapshot=state['token'], profileId=state['profiles'][0]['id'])

    def test_snapshot_hides_card_and_profile_identifiers(self):
        state = helper.snapshot(EID, PROFILES)
        self.assertNotIn('iccid', str(state))
        self.assertNotIn('eid', str(state))
        self.assertEqual(64, len(state['token']))

    def test_card_swap_and_profile_change_invalidate_snapshot(self):
        state = helper.snapshot(EID, PROFILES)
        self.assertNotEqual(state['token'], helper.snapshot('1' * 32, PROFILES)['token'])
        modified = copy.deepcopy(PROFILES)
        modified[0]['profileState'] = 'enabled'
        self.assertNotEqual(state['token'], helper.snapshot(EID, modified)['token'])

    def test_stale_snapshot_never_dispatches_a_write(self):
        session = FakeSession()
        request = self.request('enable', session)
        session.rows[0]['profileState'] = 'enabled'
        with self.assertRaisesRegex(helper.Refusal, 'stale_snapshot'):
            session.operate(request)
        self.assertFalse(session.dispatched)
        self.assertEqual([], session.calls)

    def test_enabled_profile_is_never_deleted(self):
        session = FakeSession()
        session.rows[0]['profileState'] = 'enabled'
        with self.assertRaisesRegex(helper.Refusal, 'active_profile'):
            session.operate(self.request('delete', session))
        self.assertFalse(session.dispatched)

    def test_delete_and_enable_are_read_back(self):
        for action in ('delete', 'enable'):
            session = FakeSession()
            result = session.operate(self.request(action, session))
            self.assertTrue(session.dispatched)
            if action == 'delete':
                self.assertEqual([], result['profiles'])
            else:
                self.assertEqual('enabled', result['profiles'][0]['state'])

    def test_download_credentials_use_stdin_and_remain_disabled(self):
        session = FakeSession()
        request = self.request('download', session)
        request.update(activationCode='LPA:1$rsp.example.com$TEST', confirmationCode='123456')
        result = session.operate(request)
        argv, data = session.calls[1]
        self.assertEqual(('profile', 'download', '-a', '-', '-c', '-'), argv)
        self.assertEqual('LPA:1$rsp.example.com$TEST\n123456\n', data)
        self.assertTrue(all(row['state'] == 'disabled' for row in result['profiles']))

    def test_uncertain_write_is_never_retried(self):
        session = FakeSession()
        session.fail = True
        with self.assertRaises(ValueError):
            session.operate(self.request('enable', session))
        self.assertEqual(1, sum(args[:2] == ('profile', 'enable') for args, _ in session.calls))

    def test_unknown_or_duplicate_profile_states_are_refused(self):
        with self.assertRaises(helper.Refusal):
            helper.snapshot(EID, [dict(iccid='0' * 19, profileState='unknown')])
        with self.assertRaises(helper.Refusal):
            helper.snapshot(EID, PROFILES + PROFILES)


    def test_late_card_refusal_retains_an_unknown_write_outcome(self):
        session = FakeSession()
        def uncertain(_request):
            session.dispatched = True
            raise helper.Refusal('card_unavailable')
        session.operate = uncertain
        session.acquire = lambda _device: None
        session.close = lambda: None
        request = dict(stableKey='synthetic', device='0', acknowledged=True)
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(helper, 'LOCK', directory + '/lock'), \
                 patch.object(helper, 'read_config', return_value={}), \
                 patch.object(helper, 'Session', return_value=session), \
                 patch.object(helper.sys, 'stdin', io.StringIO(json.dumps(request))), \
                 contextlib.redirect_stdout(output):
                helper.main()
        self.assertEqual(dict(success=False, error='outcome_unknown'), json.loads(output.getvalue()))


if __name__ == '__main__':
    unittest.main()
