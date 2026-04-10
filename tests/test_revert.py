"""Test: revert_all_changes works via direct revert functions (no patch dependency)."""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# Import edog module
script_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, script_dir)

import importlib.util  # noqa: E402 — must be after sys.path.insert

spec = importlib.util.spec_from_file_location('edog', os.path.join(script_dir, 'edog.py'))
edog = importlib.util.module_from_spec(spec)
os.chdir(script_dir)
spec.loader.exec_module(edog)

SERVICE = Path('Service/Microsoft.LiveTable.Service')
ENTRY = Path('Service/Microsoft.LiveTable.Service.EntryPoint')

originals = {
    'ParametersManifest': '{\n  "DisableFLTAuth": false,\n  "Other": "value"\n}\n',
    'TestRollout': '{\n  "WorkspacePool": "WHP_POOL",\n  "FabricPublicApiHost": "https://api.fabric.microsoft.com"\n  }\n}\n',
    'Program': 'using System;\n\nnamespace Test\n{\n    public static class Program\n    {\n        public static async Task Main(string[] args)\n        {\n            await new WorkloadApp().RunAsync(args);\n        }\n    }\n}\n',
    'WorkloadApp': 'using System;\n\nnamespace Test\n{\n    public class WorkloadApp\n    {\n        void Init()\n        {\n            WireUp.RegisterSingletonType<ICustomLiveTableTelemetryReporter, CustomLiveTableTelemetryReporter>();\n        }\n    }\n}\n',
}

files = {
    'ParametersManifest': ENTRY / 'WorkloadParameters/ParametersManifest.json',
    'TestRollout': ENTRY / 'WorkloadParameters/Rollouts/Test.json',
    'Program': ENTRY / 'Program.cs',
    'WorkloadApp': SERVICE / 'WorkloadApp.cs',
}

def setup_repo():
    tmpdir = tempfile.mkdtemp(prefix='edog_test_')
    os.chdir(tmpdir)
    subprocess.run(['git', 'init'], capture_output=True)
    subprocess.run(['git', 'config', 'user.email', 'test@test.com'], capture_output=True)
    subprocess.run(['git', 'config', 'user.name', 'Test'], capture_output=True)
    for key, rel_path in files.items():
        full = Path(tmpdir) / rel_path
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(originals[key], encoding='utf-8')
    subprocess.run(['git', 'add', '.'], capture_output=True)
    subprocess.run(['git', 'commit', '-m', 'init'], capture_output=True)
    return Path(tmpdir)

def apply_edog_changes(repo_root):
    """Simulate what apply_all_changes does."""
    # ParametersManifest
    fp = repo_root / files['ParametersManifest']
    c = fp.read_text(encoding='utf-8')
    fp.write_text(c.replace('"DisableFLTAuth": false', '"DisableFLTAuth": true'), encoding='utf-8')

    # TestRollout
    fp = repo_root / files['TestRollout']
    c = fp.read_text(encoding='utf-8')
    new_c, _status = edog.apply_disable_flt_auth_test_json(c)
    fp.write_text(new_c, encoding='utf-8')

    # Program.cs
    fp = repo_root / files['Program']
    c = fp.read_text(encoding='utf-8')
    new_c, _status = edog.apply_log_viewer_registration_program_cs(c)
    fp.write_text(new_c, encoding='utf-8')

    # WorkloadApp.cs
    fp = repo_root / files['WorkloadApp']
    c = fp.read_text(encoding='utf-8')
    new_c, _status = edog.apply_log_viewer_registration_workloadapp_cs(c)
    fp.write_text(new_c, encoding='utf-8')

def check_clean(repo_root, label):
    """Check all files match originals."""
    all_clean = True
    for key, rel in files.items():
        fp = repo_root / rel
        final = fp.read_text(encoding='utf-8')
        clean = final == originals[key]
        if not clean:
            all_clean = False
            print(f'    DIRTY: {key}')
        else:
            print(f'    clean: {key}')
    icon = 'PASS' if all_clean else 'FAIL'
    print(f'  {icon}: {label}')
    return all_clean

# Test 1: Direct revert (no patch file at all)
print('=== Test 1: Direct revert without patch file ===')
repo = setup_repo()
apply_edog_changes(repo)

# Delete any patch file to prove we don't depend on it
patch = edog.get_patch_file_path()
if patch.exists():
    patch.unlink()

# Monkey-patch FILES to use our temp paths
old_files = dict(edog.FILES)
for key in files:
    edog.FILES[key] = files[key]

edog.revert_all_changes(repo)
result1 = check_clean(repo, 'Direct revert (no patch)')

# Test 2: Revert after double-apply (simulating token refresh overwrite)
print('\n=== Test 2: Revert after double-apply (token refresh) ===')
repo2 = setup_repo()
apply_edog_changes(repo2)
# Simulate second apply_all_changes overwriting patch with incomplete data
# (this was the bug - but now revert doesn't use patch)
apply_edog_changes(repo2)  # already_applied for all

edog.revert_all_changes(repo2)
result2 = check_clean(repo2, 'Revert after double-apply')

# Restore FILES
edog.FILES.update(old_files)

os.chdir('C:\\')
print(f'\nAll passed: {result1 and result2}')

