@echo off
REM EDOG DevMode Token Manager
REM 
REM Usage:
REM   edog                  - Start daemon (fetch token, apply changes, auto-refresh)
REM   edog --revert         - Revert all EDOG changes
REM   edog --status         - Check if EDOG changes are applied
REM   edog --config         - Show current config
REM   edog --config -w <id> - Update workspace ID (can combine -w, -l, -c, -r)
REM   edog --config -r <path> - Set FLT repo path
REM
REM Works from any directory when added to PATH.
REM
python "%~dp0edog.py" %*
