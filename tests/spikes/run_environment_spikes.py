"""TASK_002 diagnostic harness. No production service, downloads or user audio."""
from __future__ import annotations
import argparse
import contextlib
import datetime as dt
import hashlib
import http.client
import importlib.metadata
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
MODELS = ('nimble-v3:latest', 'qwen3:8b', 'qwen3:14b')
INPUTS = (
    'The council published the revised timetable yesterday.',
    'Could you tell me where does the next tram stop?',
    'The volunteers listened to the safety announcement.',
    'The organiser suggested to move the event indoors.',
    'The technician stopped to check the logs.',
)
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
TRIAGE = {'type': 'object', 'additionalProperties': False,
          'properties': {'schema_version': {'const': 'triage-v1'},
                         'needs_deep_review': {'type': 'boolean'},
                         'reason': {'enum': ['open_answer','ambiguous','possible_error','no_issue','unsupported']},
                         'skill_candidates': {'type': 'array', 'items': {'type': 'string'}}},
          'required': ['schema_version','needs_deep_review','reason','skill_candidates']}


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def digest(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def percentile(values, p):
    if not values:
        return None
    a = sorted(values)
    return a[max(0, math.ceil(len(a) * p) - 1)]


def admission(total, used, need, sample_age, reserve=2048):
    if sample_age > 5:
        return 'telemetry_unavailable'
    return 'ready' if total - used >= need + reserve else 'waiting_for_gpu'


def api(path, payload=None, timeout=120):
    req = urllib.request.Request('http://127.0.0.1:11434' + path,
                                 data=None if payload is None else json.dumps(payload).encode(),
                                 headers={'Content-Type': 'application/json'})
    started = time.perf_counter()
    try:
        with OPENER.open(req, timeout=timeout) as response:
            raw = response.read(1024*1024+1)
            if len(raw) > 1024*1024:
                raise ValueError('response limit')
            result = json.loads(raw)
            return {'http_status': response.status, 'response': result,
                    'elapsed_s': time.perf_counter()-started}
    except urllib.error.HTTPError as exc:
        return {'http_status': exc.code, 'response': exc.read(65536).decode(errors='replace'),
                'elapsed_s': time.perf_counter()-started}


class Evidence:
    def __init__(self, output):
        self.output = Path(output).resolve()
        if not self.output.is_relative_to(ROOT):
            raise ValueError('output must stay inside workspace')
        self.output.mkdir(parents=True, exist_ok=True)
        self.run = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        self.events = self.output / (self.run + '-trials.jsonl')

    def event(self, kind, **fields):
        obj = dict(time=now(), kind=kind, **fields)
        with self.events.open('a', encoding='utf-8') as f:
            f.write(json.dumps(obj, ensure_ascii=False) + '\n')
        print(json.dumps({k: v for k,v in obj.items() if k not in ('response','request','samples')}, ensure_ascii=False), flush=True)
        return obj

    def save(self, name, data):
        (self.output / name).write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')


class Telemetry:
    def __init__(self, evidence):
        self.evidence = evidence
        self.samples = []

    def __enter__(self):
        self.proc = subprocess.Popen([
            'nvidia-smi', '--query-gpu=memory.total,memory.used,utilization.gpu',
            '--format=csv,noheader,nounits', '--loop-ms=250'], stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.thread = threading.Thread(target=self.read, daemon=True)
        self.thread.start()
        deadline = time.monotonic()+5
        while not self.samples and time.monotonic()<deadline:
            time.sleep(.05)
        if not self.samples:
            self.__exit__(None, None, None)
            raise RuntimeError('GPU telemetry unavailable')
        return self

    def read(self):
        path = self.evidence.output / (self.evidence.run+'-gpu.jsonl')
        with path.open('a', encoding='utf-8') as f:
            for line in self.proc.stdout:
                try:
                    total, used, util = map(int, line.strip().split(','))
                    row = dict(time=now(), monotonic=time.monotonic(), total_mib=total, used_mib=used, utilization=util)
                    self.samples.append(row)
                    f.write(json.dumps(row)+'\n')
                    f.flush()
                except ValueError:
                    pass

    def stats(self, start):
        rows = [r for r in self.samples if r['monotonic']>=start]
        return dict(observed_peak_mib=max((r['used_mib'] for r in rows), default=None), samples=len(rows), sampling_ms=250)

    def __exit__(self, *args):
        if self.proc.poll() is None:
            self.proc.terminate()
        self.proc.wait(timeout=10)
        self.thread.join(timeout=5)
        self.proc.stdout.close()
        self.proc.stderr.close()


def ps_names():
    result = api('/api/ps', timeout=10)
    if result['http_status']!=200:
        raise RuntimeError('Cannot establish Ollama model ownership')
    return {m['name'] for m in result['response'].get('models', [])}, result


def ensure_no_foreign(owned=None):
    names, _ = ps_names()
    if names - ({owned} if owned else set()):
        raise RuntimeError('Ollama ownership conflict: '+repr(names))


def unload(model, ev, gpu):
    ensure_no_foreign(model)
    start = time.monotonic()
    result = api('/api/generate', {'model':model,'keep_alive':0,'stream':False}, timeout=30)
    stable = 0
    last = None
    deadline = time.monotonic()+20
    while time.monotonic()<deadline:
        names, status = ps_names()
        used = gpu.samples[-1]['used_mib']
        if model not in names and last is not None and abs(used-last)<=64:
            stable += 1
        else:
            stable = 0
        if stable>=2:
            ev.event('unload', model=model, verified=True, elapsed_s=time.monotonic()-start,
                     response=result, final_used_mib=used)
            return True
        last = used
        time.sleep(.5)
    ev.event('unload', model=model, verified=False, elapsed_s=time.monotonic()-start, response=result)
    raise RuntimeError('Model release unverified; no next GPU work allowed')


def model_payload(model, i, long=False):
    text = INPUTS[i % len(INPUTS)]
    if model.startswith('nimble'):
        return '/v1/systemone', {'model':model, 'state':text,
            'questions':{'review':{'type':'choice','instructions':'Does this sentence need deeper grammar review?',
                                 'criteria':{'review':'Possible grammatical error or ambiguity; deeper review needed.',
                                             'no_issue':'No apparent grammar issue.'}}}, 'keep_alive':'5m'}
    if long:
        return '/api/chat', {'model':model,'stream':True,'think':False,'keep_alive':'5m',
                'messages':[{'role':'user','content':'List 100 brief, distinct neutral example sentences about community activities. Number them.'}],
                'options':{'num_ctx':4096,'num_predict':512,'temperature':.2,'seed':42}}
    return '/api/chat', {'model':model,'stream':False,'think':False,'format':TRIAGE,'keep_alive':'5m',
        'messages':[{'role':'system','content':'Output triage-v1 JSON only. Classify if deeper grammar review is needed. Do not calculate scores. Use skill_candidates=[] in this transport smoke test.'},
                    {'role':'user','content':text}],
        'options':{'num_ctx':4096,'num_predict':128,'temperature':.2,'seed':42}}


def validate_model(model, response):
    import jsonschema
    if model.startswith('nimble'):
        answer = response['answers']['review']
        assert answer['type']=='choice' and answer['choice'] in ('review','no_issue')
        assert set(answer['probabilities'])=={'review','no_issue'}
        assert all(0<=x<=1 for x in answer['probabilities'].values())
        assert abs(sum(answer['probabilities'].values())-1)<.01
        assert 0<=answer['confidence']<=1
    else:
        jsonschema.validate(json.loads(response['message']['content']), TRIAGE)


def run_models(ev, gpu, deadline, warm_only=False):
    summaries = {}
    for model in MODELS:
        ensure_no_foreign()
        rows = []
        owned = False
        try:
            for phase, count in ([('warmup',1),('warm',20)] if warm_only else [('cold',5),('warmup',1),('warm',20)]):
                for i in range(count):
                    if time.monotonic()>deadline:
                        raise TimeoutError('45-minute run budget exhausted')
                    ensure_no_foreign(model if owned else None)
                    start = time.monotonic()
                    path, payload = model_payload(model, i)
                    owned = True
                    result = api(path, payload)
                    valid, error = False, None
                    if result['http_status']==200:
                        try:
                            validate_model(model,result['response'])
                            valid=True
                        except Exception as exc:
                            error=str(exc)
                    else:
                        error='HTTP '+str(result['http_status'])
                    resp = result['response']
                    metrics = {k:resp.get(k) for k in ('load_duration','prompt_eval_duration','eval_duration','prompt_eval_count','eval_count','done_reason','usage') if isinstance(resp,dict) and k in resp}
                    r=ev.event('model_trial', model=model, phase=phase, trial=i+1,
                        config_hash=digest(payload), request=payload, response=resp,
                        http_status=result['http_status'], elapsed_s=result['elapsed_s'], valid_json=valid,
                        validation_error=error, metrics=metrics, **gpu.stats(start))
                    rows.append(r)
                    if result['http_status']!=200:
                        break
                    if phase=='cold':
                        unload(model,ev,gpu)
                        owned=False
                if rows and rows[-1]['http_status']!=200:
                    break
            summaries[model] = {phase:dict(n=len(v:=[r for r in rows if r['phase']==phase]),
                    valid=sum(r['valid_json'] for r in v),p50_s=percentile([r['elapsed_s'] for r in v],.5),
                    p95_s=percentile([r['elapsed_s'] for r in v],.95),
                    observed_peak_mib=max((r['observed_peak_mib'] or 0 for r in v),default=None)) for phase in ('cold','warm')}
        finally:
            if owned:
                unload(model,ev,gpu)
        ev.save('model-summary.json',summaries)
    return summaries


def cancel_probe(ev,gpu,model='qwen3:8b'):
    ensure_no_foreign()
    start=time.monotonic()
    conn=http.client.HTTPConnection('127.0.0.1',11434,timeout=60)
    path,payload=model_payload(model,0,long=True)
    owned=False
    try:
        owned=True
        conn.request('POST',path,json.dumps(payload),{'Content-Type':'application/json'})
        res=conn.getresponse()
        first=res.readline(65536)
        if res.status!=200:
            raise RuntimeError('cancel probe HTTP '+str(res.status)+': '+first.decode(errors='replace'))
        res.close()
        conn.close()
        names,status=ps_names()
        ev.event('cancel_stream_closed',model=model,first_chunk=first.decode(errors='replace'),
                 elapsed_s=time.monotonic()-start,ps_after_close=status,
                 note='Model residency is not proof inference is still active; unload is verified separately',**gpu.stats(start))
    finally:
        conn.close()
        if owned:
            unload(model,ev,gpu)


def decision_probe(ev,gpu):
    ensure_no_foreign()
    model='nimble-v3:latest'
    payload={'model':model,'state':'The visitors listened the announcement.',
             'questions':{'review':{'type':'noul','instructions':'Does this sentence contain a possible grammatical error?',
                                    'criteria':{'false':'No apparent grammar error','true':'Possible grammatical error'}}},
             'keep_alive':'5m'}
    try:
        start=time.monotonic()
        result=api('/v1/systemone',payload)
        value=result['response'].get('answers',{}).get('review',{}).get('noul') if isinstance(result['response'],dict) else None
        ev.event('decision_noul',request=payload,response=result,
                 probability_contract_valid=isinstance(value,(int,float)) and 0<=value<=1,
                 elapsed_s=time.monotonic()-start,**gpu.stats(start))
    finally:
        unload(model,ev,gpu)


def find_stt():
    hub=Path.home()/'.cache/huggingface/hub'
    records=[]
    for d in sorted(hub.glob('*whisper*')):
        for p in sorted((d/'snapshots').glob('*')):
            if p.is_dir():
                records.append(dict(path=str(p),files=[dict(name=f.name,bytes=f.stat().st_size) for f in p.iterdir() if f.is_file()]))
    return records


def stt_child(model_path, warm, vad=False):
    # Offline applies to this child only. No package/system configuration is changed.
    os.environ['HF_HUB_OFFLINE']='1'
    os.environ['TRANSFORMERS_OFFLINE']='1'
    import numpy as np
    from faster_whisper import WhisperModel
    start=time.perf_counter()
    model=WhisperModel(model_path,device='cuda',compute_type='int8_float16',local_files_only=True,cpu_threads=4,num_workers=1)
    load=time.perf_counter()-start
    print(json.dumps(dict(kind='stt_loaded',load_s=load,model_path=model_path,compute_type='int8_float16',device='cuda')),flush=True)
    for i in range(warm+1):
        # Deliberately synthetic, not a speech accuracy benchmark. No WAV/temp file.
        audio=np.zeros(15*16000,dtype=np.float32)
        if i%2:
            t=np.arange(audio.size,dtype=np.float32)/16000
            audio[:]=.005*np.sin(2*np.pi*220*t)
        begin=time.perf_counter()
        try:
            segments,info=model.transcribe(audio,language='en',beam_size=1,vad_filter=vad,
                condition_on_previous_text=False,temperature=0,without_timestamps=True,max_new_tokens=32)
            result=list(segments)
            print(json.dumps(dict(kind='stt_warmup' if i==0 else 'stt_decode',trial=i,elapsed_s=time.perf_counter()-begin,
                input_kind='silence' if i%2==0 else 'synthetic_tone',audio_s=15,
                text=' '.join(s.text for s in result),language=info.language,vad_filter=vad)),flush=True)
        finally:
            audio.fill(0)
            del audio
    try:
        seg,info=model.transcribe(np.array([],dtype=np.float32),language='en',vad_filter=False)
        empty=list(seg)
        print(json.dumps(dict(kind='stt_empty',result='returned',segments=len(empty))),flush=True)
    except Exception as exc:
        print(json.dumps(dict(kind='stt_empty',result='rejected',error=str(exc))),flush=True)
    del model


def run_stt_process(ev,gpu,path,trials,label,vad=False):
    ensure_no_foreign()
    start=time.monotonic()
    cmd=[sys.executable,str(Path(__file__).resolve()),'--mode','stt-child','--stt-path',path,'--trials',str(trials)]
    if vad:
        cmd.append('--vad')
    proc=subprocess.Popen(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',
                          env=dict(os.environ,PYTHONIOENCODING='utf-8',HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1'),
                          creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    try:
        stdout,stderr=proc.communicate(timeout=180)
    except subprocess.TimeoutExpired:
        proc.terminate()
        stdout,stderr=proc.communicate(timeout=15)
    records=[]
    for line in stdout.splitlines():
        try: records.append(json.loads(line))
        except ValueError: pass
    ev.event('stt_process',label=label,command=cmd,exit_code=proc.returncode,
             elapsed_s=time.monotonic()-start,response=records,stderr=stderr,**gpu.stats(start))
    # Child exit releases its CUDA context; require two plateau observations before LLM.
    time.sleep(1)
    ev.event('stt_release',label=label,child_exited=proc.poll() is not None,final_used_mib=gpu.samples[-1]['used_mib'])
    return proc.returncode,records


def abort_stt_process(ev,gpu,path):
    ensure_no_foreign()
    baseline=gpu.samples[-1]['used_mib']
    start=time.monotonic()
    cmd=[sys.executable,str(Path(__file__).resolve()),'--mode','stt-child','--stt-path',path,'--trials','100']
    proc=subprocess.Popen(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',
                          env=dict(os.environ,PYTHONIOENCODING='utf-8',HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1'),
                          creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    # Dedicated child watchdog, never addresses a shared service or arbitrary PID.
    watchdog=threading.Timer(30,lambda:proc.terminate() if proc.poll() is None else None)
    watchdog.start()
    try:
        first=proc.stdout.readline()
        proc.terminate()
        stdout,stderr=proc.communicate(timeout=15)
    finally:
        watchdog.cancel()
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=15)
    time.sleep(1.5)
    last=[s['used_mib'] for s in gpu.samples[-2:]]
    ev.event('stt_forced_child_exit',command=cmd,first_record=first.strip(),
             expected_nonzero_exit_code=proc.returncode,stderr=stderr,
             child_exited=proc.poll() is not None,baseline_mib=baseline,release_samples_mib=last,
             release_observed=bool(last) and max(last)<=baseline+128,
             elapsed_s=time.monotonic()-start,**gpu.stats(start))


def inventory(ev):
    env=dict(time=now(),python=sys.version,executable=sys.executable,cwd=str(ROOT),
             command=sys.argv,authorization='User: давай, делай тест (2026-10-28 Brisbane)',
             packages={n:importlib.metadata.version(n) for n in ('faster-whisper','ctranslate2','numpy','jsonschema')},
             ollama=api('/api/version'),tags=api('/api/tags'),ps=api('/api/ps'),stt_candidates=find_stt(),
             gpu=subprocess.run(['nvidia-smi','--query-gpu=name,memory.total,memory.used,driver_version,utilization.gpu','--format=csv,noheader'],capture_output=True,text=True).stdout)
    ev.save('environment.json',env)
    ev.save(ev.run+'-environment.json',env)
    return env


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--mode',choices=['inventory','models','warm','stt','stt-abort','vad','cancel','decision','switch','all','stt-child'],default='inventory')
    p.add_argument('--output',default='documentation/spec/evidence/task-002')
    p.add_argument('--allow-inference',action='store_true')
    p.add_argument('--stt-path')
    p.add_argument('--trials',type=int,default=20)
    p.add_argument('--vad',action='store_true')
    args=p.parse_args()
    if args.mode=='stt-child':
        if os.environ.get('HF_HUB_OFFLINE')!='1':
            p.error('stt-child requires offline parent')
        stt_child(args.stt_path,args.trials,vad=args.vad)
        return
    ev=Evidence(ROOT/args.output)
    env=inventory(ev)
    if args.mode=='inventory':
        ev.event('inventory_complete')
        return
    if not args.allow_inference:
        p.error('inference requires explicit --allow-inference')
    ensure_no_foreign()
    if args.stt_path:
        path=Path(args.stt_path).resolve()
        if not all((path/n).is_file() for n in ('model.bin','tokenizer.json','config.json')):
            raise RuntimeError('STT local weights/tokenizer incomplete')
    else:
        path=None
    deadline=time.monotonic()+45*60
    with Telemetry(ev) as gpu:
        ev.event('baseline',sample=gpu.samples[-1])
        if args.mode in ('models','warm','all'):
            run_models(ev,gpu,deadline,warm_only=args.mode=='warm')
        if args.mode in ('cancel','all'):
            cancel_probe(ev,gpu)
        if args.mode in ('decision','all'):
            decision_probe(ev,gpu)
        if args.mode=='vad' and path:
            run_stt_process(ev,gpu,str(path),20,'vad20',vad=True)
        if args.mode=='stt-abort' and path:
            abort_stt_process(ev,gpu,str(path))
        if args.mode in ('stt','all'):
            if path:
                rc,rows=run_stt_process(ev,gpu,str(path),20,'warm20')
                if rc==0:
                    for i in range(5):
                        rc,_=run_stt_process(ev,gpu,str(path),1,f'cold{i+1}')
                        if rc: break
            else:
                ev.event('stt_to_verify',reason='No explicit local weight path selected')
        if args.mode in ('switch','all') and path:
            for i in range(5):
                ensure_no_foreign()
                start=time.monotonic()
                route,payload=model_payload('qwen3:8b',i)
                result=api(route,payload)
                ev.event('switch_llm',trial=i+1,response=result,elapsed_s=time.monotonic()-start)
                unload('qwen3:8b',ev,gpu)
                released=time.monotonic()
                rc,rows=run_stt_process(ev,gpu,str(path),1,f'switch{i+1}')
                ev.event('switch_complete',trial=i+1,exit_code=rc,total_s=time.monotonic()-start,release_to_stt_exit_s=time.monotonic()-released)
                if rc: break
        ev.event('finished',ps=api('/api/ps'),sample=gpu.samples[-1])


if __name__=='__main__':
    main()
