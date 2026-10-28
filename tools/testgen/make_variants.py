import os, subprocess, json, shutil
os.chdir(os.path.dirname(os.path.abspath(__file__)))
OUT='out'; V='variants'
os.makedirs(V, exist_ok=True)
for _f in os.listdir(V): os.remove(os.path.join(V,_f))
exp=json.load(open(os.path.join(OUT,'expected.json')))
newexp={}
for f,e in exp.items():
    src=os.path.join(OUT,f); base=f[:-4]
    shutil.copy(src, os.path.join(V,f)); newexp[f]=e
    # Objekt-Streams + Xref-Stream
    t=os.path.join(V,base+'__objstm.pdf')
    subprocess.run(['qpdf','--object-streams=generate',src,t],check=True); newexp[os.path.basename(t)]=e
    # linearisiert
    t=os.path.join(V,base+'__linear.pdf')
    subprocess.run(['qpdf','--linearize',src,t],check=True); newexp[os.path.basename(t)]=e
    # kaputte startxref-Angabe (Rekonstruktion)
    d=open(src,'rb').read()
    i=d.rfind(b'startxref')
    j=d.find(b'%%EOF',i)
    broken=d[:i]+b'startxref\n123\n'+d[j:]
    t=os.path.join(V,base+'__brokenxref.pdf'); open(t,'wb').write(broken); newexp[os.path.basename(t)]=e
# Preview-artige Zusatz-Revision (wie bei der echten Datei: /Annots [] + Info)
import re as _re
def preview_append(src, dst):
    d=open(src,'rb').read()
    import pikepdf
    p=pikepdf.open(src)
    pg=p.pages[0].obj
    num,gen=pg.objgen
    # Seitenobjekt-Text finden (neueste Fassung)
    ms=list(_re.finditer(rb'(?<![0-9])%d %d obj' % (num,gen), d))
    start=ms[-1].start(); end=d.index(b'endobj', start)
    body=d[start:end].split(b'obj',1)[1].strip()
    if body.startswith(b'<<') and b'/Annots' not in body: body=b'<< /Annots [ ] '+body[2:]
    sx=int(_re.findall(rb'startxref\s+(\d+)', d)[-1])
    tr=p.trailer
    size=int(tr.Size); root=tr.Root.objgen; info=tr.Info.objgen if '/Info' in tr else None
    out=bytearray(d)
    if not out.endswith(b'\n'): out+=b'\n'
    off=len(out)
    out+=b'%d %d obj\n' % (num,gen) + body + b'\nendobj\n'
    x=len(out)
    out+=b'xref\n0 1\n0000000000 65535 f \n%d 1\n%010d %05d n \n' % (num, off, gen)
    out+=b'trailer\n<< /Root %d %d R /Size %d /Prev %d >>\nstartxref\n%d\n%%%%EOF\n' % (root[0],root[1],size,sx,x)
    open(dst,'wb').write(bytes(out))
for f,e in list(exp.items()):
    if f.endswith('.pdf') and '__' not in f:
        t=os.path.join(V,f[:-4]+'__preview.pdf')
        preview_append(os.path.join(OUT,f), t); newexp[os.path.basename(t)]=e
# optional: echte Kilanka-Datei (nur lokal, nie einchecken) ueber KILANKA_PDF
if os.environ.get('KILANKA_PDF'):
    shutil.copy(os.environ['KILANKA_PDF'], os.path.join(V,'real_kilanka_okt.pdf'))
    newexp['real_kilanka_okt.pdf']={'variant':'alt','nachweise':[{'tage':7,'direkt':'30,83','indirekt':'1,40','gesamt':'32,23','pinneberg':{'indirekt':'6,17','gesamt':'37,00'}}]}
json.dump(newexp, open(os.path.join(V,'expected.json'),'w'), ensure_ascii=False, indent=1)
print(len(newexp),'Testdateien')
