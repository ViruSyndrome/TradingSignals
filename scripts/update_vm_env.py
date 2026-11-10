import re

path = '/home/ubuntu/Trading/.env'
with open(path, 'r') as f:
    content = f.read()

def set_val(k, v):
    global content
    if re.search(r'^' + k + r'=.*', content, re.M):
        content = re.sub(r'^' + k + r'=.*', k + '=' + v, content, flags=re.M)
    else:
        content += '\n' + k + '=' + v

set_val('DHAN_AUTO_INSTRUMENTS', 'NIFTY,CRUDEOIL,NG')
set_val('REDBAR_BOT_INSTRUMENTS', 'NIFTY,CRUDEOIL,NG')
set_val('DHAN_CRUDEOIL_LOTS', '1')
set_val('DHAN_NG_LOTS', '1')

with open(path, 'w') as f:
    f.write(content.strip() + '\n')
print('Updated .env successfully on VM')
