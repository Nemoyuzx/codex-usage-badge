"""Allowlist-based portable release archives. Requires only the Python standard library."""
from pathlib import Path
import argparse
import hashlib
import json
import platform
import subprocess
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
package = json.loads((root / 'package.json').read_text())
parser = argparse.ArgumentParser()
parser.add_argument('--platform', choices=['macOS', 'Windows'])
options = parser.parse_args()
subprocess.run([sys.executable, str(root / 'build.py')], check=True)
dist = root / 'dist'
dist.mkdir(exist_ok=True)
archives = []
platforms = [options.platform] if options.platform else (['macOS', 'Windows'] if platform.system() == 'Darwin' else ['Windows'])
if 'macOS' in platforms:
    subprocess.run([sys.executable, str(root / 'scripts/build_native.py')], check=True)
for target_platform in platforms:
    version = package.get('windowsVersion', package['version']) if target_platform == 'Windows' else package['version']
    name = f'CodexUsageBadge-{target_platform}-{version}'
    dest = dist / name
    dest.mkdir(exist_ok=True)
    mapping = {'agent.cjs':'agent.cjs','README.md':'README.md','CHANGELOG.md':'CHANGELOG.md','LICENSE':'LICENSE','SECURITY.md':'SECURITY.md','docs/windows.md':'docs/windows.md','docs/macos.md':'docs/macos.md','docs/development.md':'docs/development.md','assets/cover.png':'assets/cover.png'}
    modes = {}
    generated = {}
    if target_platform == 'macOS':
        if f"const VERSION='{version}';" not in (root / 'manage.cjs').read_text():
            raise SystemExit('macOS installer version does not match package metadata')
        mapping.update({'manage.cjs':'manage.cjs','scripts/mac-entry.sh':'scripts/mac-entry.sh','macos/shortcuts.cjs':'macos/shortcuts.cjs','macos/startup/bridge':'.devtools/macos-startup-bridge','macos/startup/controller.cjs':'macos/startup/controller.cjs','macos/startup/watch.cjs':'macos/startup/watch.cjs'})
        for filename in ['core.cjs', 'worker.cjs', 'run.sh']:
            mapping['updater/'+filename] = 'updater/'+filename
        generated['update.json'] = (json.dumps({'schema':1,'repository':'Nemoyuzx/codex-usage-badge','platform':'macOS','version':version},sort_keys=True)+'\n').encode()
        modes['updater/run.sh'] = 0o755
        modes['scripts/mac-entry.sh'] = 0o755
        modes['macos/startup/bridge'] = 0o755
        for filename, action in [('安装.command','install'),('诊断.command','status'),('卸载.command','uninstall'),('检查更新.command','update-check'),('关闭自动更新.command','update-disable'),('开启自动更新.command','update-enable')]:
            generated[filename] = f'#!/bin/bash\nexec /bin/bash "$(dirname "$0")/scripts/mac-entry.sh" {action}\n'.encode()
            modes[filename] = 0o755
    else:
        mapping.update({'manage-windows.ps1':'windows/manage-windows.ps1','bridge.cjs':'windows/bridge.cjs','update.cjs':'windows/update.cjs','update-windows.ps1':'windows/update-windows.ps1','README-Windows.md':'docs/windows.md'})
        for filename in ['controller.cjs','windows.cjs','windows-bridge.ps1','windows-native.cs']:
            mapping['startup/'+filename] = 'startup/'+filename
        for action in ['Install','Launch','Status','Uninstall','Update']:
            text = f'@echo off\nsetlocal\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0manage-windows.ps1" -Action {action}\nset "BADGE_EXIT=%ERRORLEVEL%"\nif not "%BADGE_EXIT%"=="0" echo Operation failed. See the message above.\npause\nexit /b %BADGE_EXIT%\n'
            generated[action+'.cmd'] = text.replace('\n','\r\n').encode('ascii')
    payload = {file:(root / source).read_bytes() for file,source in mapping.items()}
    payload.update(generated)
    if target_platform == 'Windows':
        agent_version = f"var AGENT_VERSION = '{package['version']}';".encode()
        if payload['agent.cjs'].count(agent_version) != 1:
            raise SystemExit('Agent version does not match package metadata')
        payload['agent.cjs'] = payload['agent.cjs'].replace(agent_version, f"var AGENT_VERSION = '{version}';".encode())
        for filename in list(payload):
            if filename.endswith('.ps1'):
                ps = payload[filename].decode('utf-8-sig').replace('\r\n','\n')
                payload[filename] = b'\xef\xbb\xbf' + ps.replace('\n','\r\n').encode('utf-8')
    payload['SHA256SUMS.txt'] = ''.join(f'{hashlib.sha256(data).hexdigest()}  {file}\n' for file,data in sorted(payload.items())).encode()
    archive = dist / (name+'.zip')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
        for file,data in sorted(payload.items()):
            target = dest / file
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(data)
            target.chmod(modes.get(file,0o644))
            info = zipfile.ZipInfo(name+'/'+file, date_time=(2026,1,1,0,0,0))
            info.create_system = 3
            info.external_attr = (0o100000 | modes.get(file,0o644)) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info,data)
    archives.append(archive)
    print(archive.name)
(dist/'SHA256SUMS.txt').write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in archives))
