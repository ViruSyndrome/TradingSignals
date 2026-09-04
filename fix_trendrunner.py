import os
import re

os.chdir(r'C:\Users\Vinod\Desktop\Trading')

desc = '<meta name="description" content="Discover algorithmic crypto intelligence with TrendRunner. Track trends, identify breakouts, and backtest strategies for Bitcoin and top altcoins.">'
for file in ['terms.html', 'about.html', 'privacy.html']:
    if os.path.exists(file):
        with open(file, 'r', encoding='utf-8') as f:
            content = f.read()
        if '<meta name="description"' not in content:
            content = content.replace('<head>', f'<head>\n    {desc}')
            with open(file, 'w', encoding='utf-8') as f:
                f.write(content)

with open('index.html', 'r', encoding='utf-8') as f:
    index = f.read()
if '<h1' not in index.lower():
    index = re.sub(r'<h2([^>]*)>(.*?)</h2>', r'<h1\1>\2</h1>', index, count=1, flags=re.IGNORECASE|re.DOTALL)
    with open('index.html', 'w', encoding='utf-8') as f:
        f.write(index)

print('TrendRunner fixed')
