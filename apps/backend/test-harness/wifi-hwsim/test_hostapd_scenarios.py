"""Regression checks for the predicates that qualify VM results."""

import importlib.util
import hashlib
from pathlib import Path
import socket
import time
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location("scenarios", Path(__file__).with_name("hostapd-scenarios.py"))
scenarios = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scenarios)
A, B = scenarios.STA.values()


def ping_log(first):
    return "\n".join([
        *(f"[{first + seq * 0.04:.6f}] 64 bytes: icmp_seq={seq}" for seq in range(1, 31)),
        "30 packets transmitted, 30 received, 0% packet loss",
    ])


class EvidenceTests(unittest.TestCase):
    def test_late_print_of_queued_reply_cannot_replace_fresh_probe(self):
        monitor = Mock()
        monitor.transitions.return_value = []
        train, probe = Mock(), Mock()
        train.wait.return_value = 0
        probe.wait.return_value = 1
        # The train's printed timestamps appear to span the reload. It can
        # still consist entirely of packets that arrived before the reload.
        logs = {"ping": ping_log(10), "ping-after": "1 packets transmitted, 0 received"}
        with patch.object(scenarios, "authorized", return_value=True), \
             patch.object(scenarios, "launch", side_effect=[train, probe]) as launch, \
             patch.object(scenarios, "log", side_effect=logs.__getitem__):
            def reload():
                self.assertEqual(launch.call_count, 1)
                return True

            passed, _ = scenarios.continuous_ping("ping", monitor, reload)
        self.assertEqual(launch.call_args.args[0], "ping-after")
        self.assertFalse(passed)

    def test_ping_train_with_a_drop_and_rejoin_cannot_pass(self):
        monitor = Mock()
        monitor.transitions.return_value = [("DISCONNECTED", A, 10.41), ("CONNECTED", A, 10.42)]
        process = Mock()
        process.wait.return_value = 0
        logs = {"ping": ping_log(10), "ping-after": "1 packets transmitted, 1 received"}
        with patch.object(scenarios, "authorized", return_value=True), \
             patch.object(scenarios, "launch", return_value=process), \
             patch.object(scenarios, "log", side_effect=logs.__getitem__):
            passed, _ = scenarios.continuous_ping("ping", monitor, lambda: True)
            self.assertFalse(passed)
            monitor.transitions.return_value = []
            passed, _ = scenarios.continuous_ping("ping", monitor, lambda: True)
        self.assertTrue(passed)

    def test_expiry_requires_the_new_generation_and_an_on_time_reload(self):
        control = f"<3>AP-STA-CONNECTED {B} keyid=expiry-control"
        passed = scenarios.expiry_passed
        self.assertTrue(passed(True, True, control, True, 120.001, 120, True, True))
        self.assertFalse(passed(True, True, "", False, 120.001, 120, True, True))
        self.assertFalse(passed(True, True, control, False, 120.001, 120, True, True))
        self.assertFalse(passed(True, True, control, True, 119.999, 120, True, True))
        self.assertFalse(passed(True, True, control, True, 120.251, 120, True, True))

    def test_activated_control_cannot_mask_an_omitted_otp(self):
        control = Mock()
        join = f"<3>AP-STA-CONNECTED {B} keyid=expiry-control"
        for secret, expect in ((scenarios.EXPIRY_CONTROL, False), (scenarios.SECOND, True)):
            psk = hashlib.pbkdf2_hmac("sha1", secret.encode(), scenarios.SSID.encode(), 4096, 32).hex()
            control.command.side_effect = ["OK", f"ssid={scenarios.SSID}\npsk={psk}", "OK"]
            active = scenarios.active_head_matches(control, scenarios.SECOND)
            self.assertEqual(scenarios.expiry_passed(True, active, join, True, 120.001, 120, True, True), expect)
            self.assertEqual(control.command.call_args.args, ("SET wps_state 0",))

    def test_sae_set_rejects_b_dropping_and_rejoining_between_samples(self):
        monitor = Mock()
        monitor.transitions.return_value = [("DISCONNECTED", B, 10.41), ("CONNECTED", B, 10.42)]
        with patch.object(scenarios, "authorized", return_value=True):
            self.assertEqual(scenarios.sae_set_with_peer(monitor, "b", lambda: True), (True, False))
            monitor.transitions.return_value = []
            self.assertEqual(scenarios.sae_set_with_peer(monitor, "b", lambda: True), (True, True))

    def test_revoke_rejects_stale_disconnect_and_peer_recovery(self):
        def passes(changes, baseline=(True, True)):
            return scenarios.revocation_passed(True, baseline, (False, True), changes, 10)

        a_dropped = ("DISCONNECTED", A, 10.01)
        self.assertTrue(passes([a_dropped]))
        self.assertFalse(passes([("DISCONNECTED", A, 9.99)]))
        self.assertFalse(passes([a_dropped], baseline=(False, True)))
        self.assertFalse(passes([a_dropped, ("DISCONNECTED", B, 10.01), ("CONNECTED", B, 10.02)]))

    def test_iw_failure_is_an_error_and_an_empty_success_is_absence(self):
        with patch.object(scenarios.subprocess, "run") as run:
            run.return_value.returncode = 1
            run.return_value.stdout = "command failed: Operation not permitted"
            with self.assertRaisesRegex(RuntimeError, "Operation not permitted"):
                scenarios.authorized("a")
            run.return_value.returncode = 0
            run.return_value.stdout = ""
            self.assertFalse(scenarios.authorized("a"))

    def test_socket_timestamps_a_queued_event_before_the_next_operation(self):
        receiver, sender = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)
        with receiver, sender:
            receiver.setsockopt(socket.SOL_SOCKET, scenarios.SO_TIMESTAMPNS, 1)
            control = scenarios.Control.__new__(scenarios.Control)
            control.socket = receiver
            sender.send(f"<3>AP-STA-DISCONNECTED {A}".encode())
            fence = time.time()
            sender.send(f"<3>AP-STA-DISCONNECTED {B}".encode())
            self.assertEqual(scenarios.peer_event(control, "AP-STA-DISCONNECTED", "a", fence, 0.01), ("", 0))

    def test_sae_requires_valid_sta_replies_and_checks_each_join(self):
        for mac in (A, B):
            joined = f"<3>AP-STA-CONNECTED {mac}"
            reply = f"{mac}\nflags=[AUTH][ASSOC][AUTHORIZED]"
            self.assertTrue(scenarios.sae_join_has_no_id(joined, reply, mac))
            self.assertFalse(scenarios.sae_join_has_no_id(joined, "FAIL", mac))
            self.assertFalse(scenarios.sae_join_has_no_id(joined, reply + "\nsae_password_id=second", mac))
            self.assertFalse(scenarios.sae_join_has_no_id(joined + " keyid=second", reply, mac))

    def test_sae_denial_requires_fresh_peer_specific_evidence(self):
        ap_log = (
            f"9.900000: SAE-UNKNOWN-PASSWORD-IDENTIFIER {A}\n"
            "10.050000: SAE: No password available\n"
            f"10.100000: authentication reply: STA={B} auth_alg=3 auth_transaction=1 resp=1\n"
        )
        self.assertFalse(scenarios.sae_rejection(ap_log, A, 10))
        self.assertTrue(scenarios.sae_rejection(ap_log, B, 10))


if __name__ == "__main__":
    unittest.main()
