"""Regression tests for the confirmed bootout/bootstrap ordering failure."""
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / 'scripts/reload-codexpro-launchagent.py'
if not source.exists():
    source = Path(__file__).with_name('reload-codexpro-launchagent.py')
spec = importlib.util.spec_from_file_location('reload_codexpro', source)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
target = 'gui/501/' + helper.LABEL


def present():
    return subprocess.CompletedProcess([], 0, 'state = SIGTERMed\npid = 123\n', '')


def absent():
    return subprocess.CompletedProcess([], 113, '', 'Could not find service "' + helper.LABEL + '" in domain for user gui: 501')


class ReloadTests(unittest.TestCase):
    def test_bootstrap_waits_for_absence_not_bootout_return(self):
        states = iter([present(), present(), present(), absent(), subprocess.CompletedProcess([], 0, 'state = running\npid = 456\n', '')])
        calls = []
        def command(argv, checked=False):
            calls.append(argv[1])
            if argv[1] == 'print':
                return next(states)
            return subprocess.CompletedProcess(argv, 0, '', '')
        with patch.object(helper.time, 'sleep'):
            self.assertEqual(helper.reload_service(command, target, Path('/tmp/example.plist')), 456)
        self.assertEqual(calls, ['print', 'bootout', 'print', 'print', 'print', 'bootstrap', 'print'])

    def test_absent_service_can_be_bootstrapped_for_rollback(self):
        states = iter([absent(), absent(), subprocess.CompletedProcess([], 0, 'state = running\npid = 456\n', '')])
        calls = []
        def command(argv, checked=False):
            calls.append(argv[1])
            return next(states) if argv[1] == 'print' else subprocess.CompletedProcess(argv, 0, '', '')
        self.assertEqual(helper.reload_service(command, target, Path('/tmp/example.plist')), 456)
        self.assertNotIn('bootout', calls)

    def test_unknown_print_failure_is_not_absence(self):
        with self.assertRaises(RuntimeError):
            helper.job_absent(subprocess.CompletedProcess([], 1, '', 'Permission denied'))

    def test_absence_timeout_never_bootstraps(self):
        calls = []
        def command(argv, checked=False):
            calls.append(argv[1])
            return present()
        with patch.object(helper.time, 'monotonic', side_effect=[0, 31]):
            with self.assertRaises(TimeoutError):
                helper.reload_service(command, target, Path('/tmp/example.plist'))
        self.assertNotIn('bootstrap', calls)

    def test_bootout_error_stops_before_bootstrap(self):
        calls = []
        def command(argv, checked=False):
            calls.append(argv[1])
            if argv[1] == 'bootout':
                raise RuntimeError('bootout failed')
            return present()
        with self.assertRaises(RuntimeError):
            helper.reload_service(command, target, Path('/tmp/example.plist'))
        self.assertNotIn('bootstrap', calls)

    def test_bootstrap_error_does_not_retry(self):
        calls = []
        def command(argv, checked=False):
            calls.append(argv[1])
            if argv[1] == 'bootstrap':
                raise RuntimeError('bootstrap failed')
            return absent()
        with self.assertRaises(RuntimeError):
            helper.reload_service(command, target, Path('/tmp/example.plist'))
        self.assertEqual(calls.count('bootstrap'), 1)


if __name__ == '__main__':
    unittest.main()
