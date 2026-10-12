#!/usr/bin/env python3
"""Chạy lần lượt mọi bài kiểm giao diện (Chromium thật, máy chủ thật) và in bảng tổng.
   python3 test/ui/run_all.py [tên ...]   — ví dụ: run_all.py views_bo views_team
Mỗi bài tự bật máy chủ thử trên cổng riêng, nên chạy tuần tự cho ổn định. Bài 'preview' tự dựng bản xem thử một-file trước."""
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SUITES = ['e2e', 'views_dash', 'views_work', 'views_stock', 'views_bo', 'views_team', 'preview']
ROOT = os.path.join(HERE, '..', '..')
pick = [a.removesuffix('.py') for a in sys.argv[1:]] or SUITES
rows, bad = [], 0
for name in pick:
    t0 = time.time()
    extra = []
    if name == 'preview':
        extra = [os.path.join(tempfile.mkdtemp(), 'preview.html')]
        subprocess.run(['node', 'tools/build-preview.mjs', extra[0], '--inline-leaflet'], cwd=ROOT, check=True, capture_output=True)
    p = subprocess.run([sys.executable, os.path.join(HERE, name + '.py'), *extra], cwd=ROOT, capture_output=True, text=True)
    out = (p.stdout + p.stderr).strip().splitlines()
    tail = next((l for l in reversed(out) if 'đạt' in l or 'passed' in l or 'failed' in l), out[-1] if out else '')
    ok = p.returncode == 0
    bad += 0 if ok else 1
    rows.append((name, ok, round(time.time() - t0), tail))
    if not ok:
        print(f'── {name} không đạt, 40 dòng cuối:')
        print('\n'.join(out[-40:]))
print('\nKiểm thử giao diện:')
for name, ok, sec, tail in rows:
    print(f"  {'✓' if ok else '✗'} {name:<12} {sec:>4}s  {tail}")
sys.exit(1 if bad else 0)
