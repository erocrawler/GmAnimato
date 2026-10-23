#!/usr/bin/env python3
"""Sanity-check the agent-mode docs (run from repo root, no build needed).

- every link in static/llms.txt resolves to a static file or a SvelteKit route
- static/skill.md frontmatter (name, description <=160 bytes) and size (<10,000 chars)
- static/llms-full.txt == skill.md + separator + skill-reference.md
- no secret-looking strings in the shipped docs
"""
import re, sys, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
errors = []

def route_exists(path: str) -> bool:
    path = path.split('?')[0].split('#')[0]
    static = root / 'static' / path.lstrip('/')
    if path != '/' and static.is_file():
        return True
    routes = root / 'src' / 'routes'
    parts = [p for p in path.strip('/').split('/') if p]
    def walk(base: pathlib.Path, rest):
        if not rest:
            return any((base / f).is_file() for f in ('+server.ts', '+page.svelte', '+page.server.ts'))
        for child in base.iterdir() if base.is_dir() else []:
            if not child.is_dir():
                continue
            n = child.name
            if n == rest[0] or (n.startswith('[') and not n.startswith('[...')):
                if walk(child, rest[1:]):
                    return True
            if n.startswith('[...') and any((child / f).is_file() for f in ('+server.ts', '+page.svelte')):
                return True
        return False
    return walk(routes, parts)

llms = (root / 'static' / 'llms.txt').read_text()
for label, target in re.findall(r'\[([^\]]+)\]\((/[^)]*)\)', llms):
    if not route_exists(target):
        errors.append(f'llms.txt link has no file/route: {target}')

skill = (root / 'static' / 'skill.md').read_text()
m = re.match(r'---\nname: (.+)\ndescription: (.+)\n---\n', skill)
if not m:
    errors.append('skill.md frontmatter malformed')
else:
    if m.group(1) != 'animato-video': errors.append('skill name must be animato-video')
    if len(m.group(2).encode()) > 160: errors.append(f'description is {len(m.group(2).encode())} bytes (>160)')
if len(skill) >= 10000: errors.append(f'skill.md is {len(skill)} chars (>=10000)')

full = (root / 'static' / 'llms-full.txt').read_text()
ref = (root / 'static' / 'skill-reference.md').read_text()
if full != skill + '\n\n---\n\n' + ref:
    errors.append('llms-full.txt is stale: regenerate with  (cat static/skill.md; printf "\\n\\n---\\n\\n"; cat static/skill-reference.md) > static/llms-full.txt')

pat = re.compile(r'(AIza|AQ\.|sk-[A-Za-z0-9]|postgres(ql)?://|Bearer [A-Za-z0-9._-]{20,}|-----BEGIN)')
for f in ['static/llms.txt', 'static/skill.md', 'static/skill-reference.md', 'static/llms-full.txt']:
    p = root / f
    if p.exists():
        for i, line in enumerate(p.read_text().splitlines(), 1):
            if pat.search(line): errors.append(f'{f}:{i}: secret-like string')

print('\n'.join(errors) if errors else 'OK: agent docs check passed')
sys.exit(1 if errors else 0)
