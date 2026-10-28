#!/usr/bin/env python3
"""Fuehrt kzcli auf allen Varianten aus und vergleicht mit den erwarteten Werten."""
import json, os, subprocess, sys, re
HERE=os.path.dirname(os.path.abspath(__file__))
V=os.path.join(HERE,'variants')
R=os.path.join(HERE,'ergebnisse')
CLI=os.path.join(HERE,'..','..','test','cli.mjs')
os.makedirs(R, exist_ok=True)
for f in os.listdir(R): os.remove(os.path.join(R,f))
exp=json.load(open(os.path.join(V,'expected.json')))
files=sorted(f for f in os.listdir(V) if f.endswith('.pdf'))
STANDORT=sys.argv[1] if len(sys.argv)>1 else 'segeberg'
cmd=['node',CLI,'--standort',STANDORT,'--json','--outdir',R]+[os.path.join(V,f) for f in files]
res=json.loads(subprocess.run(cmd,capture_output=True,text=True,check=True).stdout)
if STANDORT=='pinneberg':
    for f,e in exp.items():
        for x in e['nachweise']:
            if 'pinneberg' in x: x['indirekt']=x['pinneberg']['indirekt']; x['gesamt']=x['pinneberg']['gesamt']
    # bereits gefuellte Datei enthaelt Segeberg-Werte -> unter Pinneberg Konflikt erwartet
    for f,e in exp.items():
        if e['variant']=='gefuellt': e['variant']='gefuellt_konflikt'

fails=0
for r in res:
    f=r['file']; e=exp[f]; variant=e['variant']
    problems=[]
    ns=r.get('nachweise',[])
    if len(ns)!=len(e['nachweise']): problems.append(f"Anzahl {len(ns)} statt {len(e['nachweise'])}")
    for n,x in zip(ns,e['nachweise']):
        if n['tage']!=x['tage']: problems.append(f"Tage {n['tage']}!={x['tage']}")
        if n['direkt']!=x['direkt']: problems.append(f"direkt {n['direkt']}!={x['direkt']}")
        if variant in ('muster','summe','labels2','frei','alt','kein_platz','gefuellt','gefuellt_konflikt','strich'):
            if n['indirekt']!=x['indirekt']: problems.append(f"indirekt {n['indirekt']}!={x['indirekt']}")
            if n['gesamt']!=x['gesamt']: problems.append(f"gesamt {n['gesamt']}!={x['gesamt']}")
        want={'muster':'bereit','summe':'bereit','labels2':'bereit','frei':'bereit','alt':'bereit','gefuellt':'bereits ergänzt','gefuellt_konflikt':'fehler','kein_platz':'fehler','strich':'fehler'}[variant]
        if not n['status'].startswith(want): problems.append(f"status '{n['status']}' statt {want}")
    out=r.get('ausgabe')
    if variant in ('muster','summe','labels2','frei','alt'):
        if not out: problems.append('keine Ausgabe: '+str(r.get('fehler')))
        else:
            host=out
            orig=open(os.path.join(V,f),'rb').read(); new=open(host,'rb').read()
            if not new.startswith(orig): problems.append('Original-Bytes veraendert')
            chk=subprocess.run(['qpdf','--check',host],capture_output=True,text=True)
            if 'No syntax or stream encoding errors' not in chk.stdout: problems.append('qpdf: '+chk.stdout[-200:]+chk.stderr[-200:])
            txt=subprocess.run(['pdftotext','-layout',host,'-'],capture_output=True,text=True).stdout
            for x in e['nachweise']:
                if not re.search(r'(Indirekte Stunden gesamt|Indirekte Zeit):?[\s_]+'+re.escape(x['indirekt'])+r'\b',txt): problems.append('pdftotext: indirekt '+x['indirekt']+' fehlt')
                if not re.search(r'(Gesamtstunden|Gesamtstundenanzahl):?[\s_]+'+re.escape(x['gesamt'])+r'\b',txt): problems.append('pdftotext: gesamt '+x['gesamt']+' fehlt')
    else:
        if out: problems.append('unerwartete Ausgabe')
    status='OK ' if not problems else 'FEHLER'
    if problems: fails+=1
    print(f"{status} {f:48s} {r['ms']:4d}ms  " + ('; '.join(problems) if problems else ', '.join(f"{n['tage']}T {n['indirekt']}/{n['gesamt']}" for n in ns)))
# Zweiter Durchlauf: ergaenzte Dateien muessen als "bereits ergaenzt" erkannt werden (keine doppelte Eintragung)
ausgaben=[r['ausgabe'] for r in res if r.get('ausgabe')]
if ausgaben:
    res2=json.loads(subprocess.run(['node',CLI,'--standort',STANDORT,'--json']+ausgaben,capture_output=True,text=True,check=True).stdout)
    for r2 in res2:
        if r2.get('fehler') or any(not n['status'].startswith('bereits') for n in r2['nachweise']):
            fails+=1
            print(f"FEHLER zweiter Durchlauf {r2['file']}: "+'; '.join(n['status'] for n in r2['nachweise'])+(' '+r2['fehler'] if r2.get('fehler') else ''))
    print(f"zweiter Durchlauf: {len(res2)} ergaenzte Dateien geprueft")
print(f"\n{len(res)-fails}/{len(res)} bestanden")
sys.exit(1 if fails else 0)
