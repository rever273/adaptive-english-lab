"""Replay saved TASK_002 evidence into a report. Never starts GPU/network work."""
from pathlib import Path
import collections
import hashlib
import json
import math

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'documentation/spec/evidence/task-002'


def q(values,p):
    return sorted(values)[max(0,math.ceil(len(values)*p)-1)] if values else None


def main():
    files=sorted(OUT.glob('*-trials.jsonl'))
    rows=[]
    for f in files:
        for line in f.read_text(encoding='utf-8').splitlines():
            r=json.loads(line)
            r['evidence_file']=f.name
            rows.append(r)
    env=json.loads((OUT/'environment.json').read_text(encoding='utf-8'))
    tags={m['name']:m for m in env['tags']['response']['models']}
    model_rows=[]
    profiles=[]
    for model in ('nimble-v3:latest','qwen3:8b','qwen3:14b'):
        allrows=[r for r in rows if r['kind']=='model_trial' and r['model']==model]
        cold=[r for r in allrows if r['phase']=='cold']
        # Dedicated second pass explicitly separates warmup and warm timing.
        goodfiles={r['evidence_file'] for r in allrows if r['phase']=='warmup'}
        warm=[r for r in allrows if r['phase']=='warm' and r['evidence_file'] in goodfiles]
        for phase,group in [('cold',cold),('warm',warm)]:
            tps=[r['metrics']['eval_count']*1e9/r['metrics']['eval_duration'] for r in group if r['metrics'].get('eval_duration',0)>0]
            model_rows.append(dict(model=model,phase=phase,n=len(group),valid=sum(r['valid_json'] for r in group),
                p50_s=q([r['elapsed_s'] for r in group],.5),p95_s=q([r['elapsed_s'] for r in group],.95),
                median_eval_tokens_per_s=q(tps,.5),observed_total_peak_mib=max((r['observed_peak_mib'] or 0 for r in group),default=0)))
        req=allrows[0]['request']
        config={'endpoint':'/v1/systemone' if model.startswith('nimble') else '/api/chat',
                'options':req.get('options'), 'think':req.get('think'), 'format':req.get('format'),
                'runtime_version':env['ollama']['response']['version'], 'question_contract':req.get('questions')}
        profiles.append(dict(model=model,digest=tags[model]['digest'],config=config,
            config_hash=hashlib.sha256(json.dumps(config,sort_keys=True).encode()).hexdigest(),
            observed_total_peak_mib=max((r['observed_peak_mib'] or 0 for r in allrows)),
            memory_scope='whole GPU at 250ms sampling, not model-only allocation',
            quality_qualification='not performed, TASK_009 remains not_authorized'))
    stt=[r for r in rows if r['kind']=='stt_process']
    stt_summary=[]
    for r in stt:
        dec=[d for d in r['response'] if d['kind']=='stt_decode']
        warmup=next((d for d in r['response'] if d['kind']=='stt_warmup'),{})
        loaded=next((d for d in r['response'] if d['kind']=='stt_loaded'),{})
        stt_summary.append(dict(label=r['label'],n=len(dec),exit_code=r['exit_code'],
            process_total_s=r['elapsed_s'],load_s=loaded.get('load_s'),warmup_s=warmup.get('elapsed_s'),
            p50_decode_s=q([d['elapsed_s'] for d in dec],.5),p95_decode_s=q([d['elapsed_s'] for d in dec],.95),
            nonempty=sum(bool(d['text'].strip()) for d in dec),observed_total_peak_mib=r['observed_peak_mib'],
            source_file=r['evidence_file']))
    switches=[r for r in rows if r['kind']=='switch_complete']
    unloads=[r for r in rows if r['kind']=='unload']
    summary=dict(status='completed_with_limitations',model_measurements=model_rows,profiles=profiles,
        stt=stt_summary,switches=switches,unloads=dict(n=len(unloads),verified=sum(r['verified'] for r in unloads),
        p95_s=q([r['elapsed_s'] for r in unloads],.95)),
        model_json_valid_all=dict(n=sum(r['kind']=='model_trial' for r in rows),
          valid=sum(r.get('valid_json',False) for r in rows if r['kind']=='model_trial')),
        cancellation=[r for r in rows if r['kind'] in ('cancel_stream_closed','stt_forced_child_exit')])
    (OUT/'summary.json').write_text(json.dumps(summary,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    lines=['# TASK_002 — результаты локальных тестов', '',
      'Дата:2026-10-28, Australia/Brisbane; raw timestamps UTC. Статус: **completed_with_limitations**. Разрешение пользователя: «давай, делай тест». Выполнен только TASK_002; TASK_003–018 не выполнялись.', '',
      '## LLM API и производительность', '',
      '| Model | Phase / n | JSON contract valid | p50 s | p95 s | Median decode tokens/s | Observed total GPU MiB |',
      '|---|---:|---:|---:|---:|---:|---:|']
    for r in model_rows:
        tokens='n/a' if r['median_eval_tokens_per_s'] is None else f"{r['median_eval_tokens_per_s']:.1f}"
        lines.append(f"| {r['model']} | {r['phase']} / {r['n']} | {r['valid']}/{r['n']} | {r['p50_s']:.3f} | {r['p95_s']:.3f} | {tokens} | {r['observed_total_peak_mib']} |")
    lines+=['',
      'Nimble проверен через **/v1/systemone**, choice и дополнительный noul yes/no probability smoke. Это decision endpoint, не chat. Qwen8b/14b — /api/chat, think=false, num_ctx4096, num_predict128, temperature.2, seed42, strict triage-v1 schema. Nimble decision API не принимает generation options; использован установленный default, не придуманное num_ctx4096. Model tags/digests и параметры сохранены в environment/summary JSON.',
      '',f"Всего model_trial JSON-valid {summary['model_json_valid_all']['valid']}/{summary['model_json_valid_all']['n']}; repair не потребовался и его failure path не измерялся. Это **не accuracy benchmark**: использованы5 коротких synthetic sentences с повторами/prompt cache, forced empty skill_candidates, без оценки правильности grammar labels/объяснений. TASK_009 и60-case quality qualification не запускались. Discovery runtime остаётся disabled до quality gate.",
      '',
      'Cold = model unloaded, OS disk/driver cache не очищался. Самый первый cold включал initial/runtime warmup: Nimble40.73s, Qwen8b39.89s, Qwen14b24.62s. При5 cold p95 — максимум небольшой выборки. Цель мгновенного первого feedback для LLM не подтверждена; deterministic feedback будущего приложения здесь не тестировался.',
      '',
      'Первый измерительный запуск пометил первый запрос после unload как warm. Исходные75 records сохранены без исправления; для итоговых warm p50/p95 выполнен отдельный проход: warmup отдельно +20 truly-resident trials/model. Поэтому общий raw count больше75. В ранних records config_hash является hash полного request; воспроизводимый runtime profile config_hash отдельно рассчитан в summary.json. Profile peak whole-GPU, включает текущие desktop процессы; 250ms sampling может пропускать короткие пики, у sub250ms отдельных Nimble requests peak=null, это не0.',
      '',
      '## STT, тишина и переключение', '',
      'Использованы уже локальные **Systran faster-whisper-small multilingual** weights, snapshot536b0662742c02347bc0e980a01041f333bce120, language=en, CUDA int8_float16; small.en отсутствует. Выбор явно сообщён пользователю; download/install/system changes не выполнялись. Python3.11.9, faster-whisper1.2.1, CTranslate2 4.7.1, driver617.42; package/runtime versions в environment.json.', '',
      '| Profile | n measured decodes | exit | Model load s | First decode warmup s | warm decode p95 s | Nonempty text | Total peak MiB |',
      '|---|---:|---:|---:|---:|---:|---:|---:|']
    for r in stt_summary:
        lines.append(f"| {r['label']} | {r['n']} | {r['exit_code']} | {r['load_s']:.3f} | {r['warmup_s']:.3f} | {r['p95_decode_s']:.3f} | {r['nonempty']} | {r['observed_total_peak_mib']} |")
    lines+=['',
      '**Найден реальный failure mode:** VAD=false выдавал `you` на silence/tone (20/20 measured warm cases). Дополнительный VAD=true прогон дал empty transcript20/20; VAD использует уже установленный bundled asset, offline. Для будущего STT обязательны VAD/no-speech handling, редактируемый preview и отсутствие автоматического Submit. Synthetic silence/tone не заменяют реальные слова: скорость/accuracy/WER реальной речи, UI microphone и false-negative VAD на тихой речи остаются **To verify**. Первый CUDA decode warmup26.833s превышает proposed idle preparation10s; это записанный failure SLO, не скрытый pass. Полный первый child elapsed34.265s включает imports/load/warmup/trials.',
      '',
      f"Пять sequential Qwen8b→unload→STT runs: completed={sum(r['exit_code']==0 for r in switches)}/{len(switches)}, total including fresh LLM request and STT child exit p95={q([r['total_s'] for r in switches],.95):.3f}s; unload-finished→STT child exited p95={q([r['release_to_stt_exit_s'] for r in switches],.95):.3f}s. Это upper-bound до окончания child, **не** точная browser STT Ready latency; initial first-use26.833s в этих пяти уже не повторялся. Проверен порядок без одновременной model residency; production GPU scheduler ещё отсутствует.",
      '',
      f"Явная unload проверена {summary['unloads']['verified']}/{summary['unloads']['n']} раз, p95={summary['unloads']['p95_s']:.3f}s, /api/ps absence + VRAM plateau. Cancel: streaming Qwen8b socket закрыт после первого chunk done=false, затем explicit unload≈1.688s; закрытие socket само по себе **не** доказательство instantaneous CUDA preemption. Forced termination только собственного STT child после loaded record завершилась expected exit1 и вернула GPU1931/1930MiB к baseline1936MiB. Shared Ollama и чужие процессы не останавливались.",
      '',
      '## Pass / limitations и дальнейший gate', '',
      '- PASS: installed model identity; real decision+chat transport; structured JSON; sequential residency/unload; Python3.11 CUDA Whisper decode; local offline assets;20 warm+5 cold model trials и STT20 warm+5 restart trials;5 switches; empty input returns no segments; owned-child forced-exit release.',
      '- PASS только harness fault injection: stale telemetry→telemetry_unavailable; insufficient VRAM→waiting_for_gpu. Реальный OOM/competing CUDA stress не создавались, production queue/recovery/pause semantics не тестировались.',
      '- LIMITATION/FAIL SLO: first-use latency LLM и Whisper warmup; raw silence hallucination при VAD=false; no real-speech accuracy/latency, no educational-content qualification; Nimble cancel и full backend/WS disconnect не тестировались, вместо них documented owned child teardown smoke.',
      '- При текущем desktop baseline≈1.9–2.2GiB и выбранных contexts observed LLM peak≤12.3kMiB на16311MiB карте оставлял proposed2048MiB reserve. Это observed scenario, не гарантия при чужой CUDA нагрузке или больших contexts/batches. STT peak и LLM peak не складывать для разрешения concurrent residency.',
      '- Существующая архитектура пригодна для следующей отдельно разрешённой задачи; менять stack не требуется. До выпуска закрыть real-speech/VAD usability и cold-start gate, quality benchmark TASK_009, production scheduler TASK_008. Оставить правдивый Preparing state и typing fallback.',
      '',
      '## Доказательства, воспроизведение и cleanup', '',
      '[summary.json](summary.json) содержит числовые aggregates/profiles; per-run *-trials.jsonl сохраняют requests/responses/metrics/commands, *-gpu.jsonl —250ms telemetry; *-environment.json —versions. [harness-tests.txt](harness-tests.txt) — CPU-only unit tests, exit0. В raw stt_process вложены child load/decode/empty records, exit codes и stderr. [commands.json](commands.json) — фактические запуски/коды выхода. Скрипты только в tests/spikes, production apps/workers/node_modules/var не создавались; migrations none, DB отсутствует. Audio генерировалось только RAM, никаких аудиофайлов/микрофона; raw records содержат лишь synthetic transcripts.',
      '',
      'Все harness Python/STT children и telemetry processes завершены; итоговые /api/ps и GPU sample сохраняются в final-state.json. Общий Ollama остаётся пользовательским сервисом. Rollback: удалить только эти diagnostic scripts/artifacts при необходимости; системных изменений/скачанных весов/БД для отката нет.',
      '',
      'Первичные API-источники, сверенные до probes: [Ollama Decision](https://github.com/ollama/ollama/blob/main/docs/capabilities/decision.mdx), [Ollama OpenAPI](https://github.com/ollama/ollama/blob/main/docs/openapi.yaml). Реальное поведение установленной0.40.12 подтверждено raw responses, а не одним чтением документации.'
    ]
    (OUT/'summary.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print(json.dumps(dict(model_measurements=model_rows,unloads=summary['unloads'],stt=stt_summary[:1]),indent=2))


if __name__=='__main__': main()
