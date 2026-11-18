"""Opt-in live website/scheduler/restart check; creates only disposable QA records."""
import argparse
import json
import os
from pathlib import Path
import secrets
import sqlite3
import subprocess
import sys
import time

import httpx


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8003)
    args = parser.parse_args()
    directory = args.data_dir.resolve()
    if not directory.name.startswith('.qa-') or not (directory / 'trade.db').is_file():
        raise SystemExit('Use an initialized disposable .qa- database')
    root = Path(__file__).resolve().parents[2]
    token = secrets.token_hex(24)
    with sqlite3.connect(directory / 'trade.db') as conn:
        user = conn.execute("SELECT id FROM users WHERE role='admin' AND active=1 LIMIT 1").fetchone()
        conn.execute("INSERT INTO sessions VALUES(?,?,'2099-01-01T00:00:00.000Z')", (token, user[0]))
    env = {**os.environ, 'TRADE_DATA_DIR': str(directory), 'DISCOVERY_SEED_URLS': 'https://www.cbi.com.pk/',
           'DISCOVERY_SEARCH_PROVIDER': 'duckduckgo', 'SERPAPI_API_KEY': '', 'DISCOVERY_SCHEDULE_SECONDS': '0', 'DISCOVERY_TEST_MODE': '1',
           'PYTHONPATH': os.pathsep.join([str(root / 'backend'), str(root / 'backend/.venv/Lib/site-packages')])}
    client = httpx.Client(base_url=f'http://127.0.0.1:{args.port}', cookies={'cp_session': token}, timeout=10)
    log = (directory / 'background-server.log').open('a', encoding='utf-8')
    process = None

    def start():
        # Base executable avoids leaving a Windows venv redirector child behind.
        proc = subprocess.Popen([sys._base_executable, '-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', str(args.port)],
                                cwd=root / 'backend', env=env, stdout=log, stderr=log)
        for _ in range(60):
            if proc.poll() is not None:
                raise RuntimeError('Backend failed; inspect background-server.log')
            try:
                if client.get('/health').status_code == 200:
                    return proc
            except httpx.RequestError:
                pass
            time.sleep(.5)
        proc.terminate()
        raise RuntimeError('Backend startup timed out')

    def api(route, body=None):
        response = client.get('/api/v1/discovery/' + route) if body is None else client.post('/api/v1/discovery/' + route, json=body)
        response.raise_for_status()
        return response.json()

    report = {'website': 'REAL https://www.cbi.com.pk/', 'browser': 'CLOSED throughout timed execution', 'checks': []}
    try:
        process = start()
        baseline = {j['id'] for j in api('jobs')['items']}
        payload = {'enabled': True, 'interval_seconds': 60,
                   'filters': {'product': 'corrugated', 'city': 'Lahore', 'keywords': '', 'mode': 'seeds'}}
        saved = api('schedule', payload)
        assert saved['status'] == 'Scheduled'
        print('Waiting for real seed schedule, browser closed; due ' + saved['next_run_at'], flush=True)
        for _ in range(110):
            jobs = [j for j in api('jobs')['items'] if j['id'] not in baseline and j['trigger_type'] == 'Scheduled']
            if jobs and jobs[0]['status'] in ('Completed', 'Failed'):
                break
            time.sleep(1)
        assert jobs and jobs[0]['status'] == 'Completed', jobs
        job = jobs[0]
        assert job['found'] + job['duplicates'] >= 1
        report['scheduled_job'] = job
        report['checks'].append('PASS: elapsed-time seed job without browser or DuckDuckGo key')
        before = api('leads?q=Corruboard')
        assert before['total'] == 1
        next_due = api('summary')['schedule']['next_run_at']
        process.terminate()
        process.wait(timeout=15)
        process = start()
        assert api('leads?q=Corruboard') == before
        assert api('jobs/' + str(job['id']))['status'] == 'Completed'
        assert api('summary')['schedule']['next_run_at'] == next_due
        report['checks'].append('PASS: results, history and next schedule survive actual backend process restart')
        api('schedule', {**payload, 'enabled': False})
        report['checks'].append('PASS: schedule disabled after QA')
        print('\n'.join(report['checks']), flush=True)
    finally:
        if process and process.poll() is None:
            process.terminate()
            process.wait(timeout=15)
        client.close()
        log.close()
        with sqlite3.connect(directory / 'trade.db') as conn:
            conn.execute('DELETE FROM sessions WHERE token=?', (token,))
        (directory / 'background-live-results.json').write_text(json.dumps(report, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
