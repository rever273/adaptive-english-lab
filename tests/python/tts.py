import sys
import subprocess
from kokoro import KPipeline
import soundfile as sf

# 1. Получаем ответ от Ollama
prompt = sys.argv[1] if len(sys.argv) > 1 else "Hello"
result = subprocess.run(["ollama", "run", "llama3.2:3b", prompt], capture_output=True, text=True, encoding='utf-8')
text_response = result.stdout.strip()

print(f"Ollama: {text_response}")

# 2. Озвучиваем ответ через Kokoro TTS
pipeline = KPipeline(lang_code='a')
generator = pipeline(text_response, voice='af_nicole', speed=1.0)

for i, (gs, ps, audio) in enumerate(generator):
    sf.write(f'ollama_response_{i}.wav', audio, 24000)
    print(f"Аудио сохранено в ollama_response_{i}.wav")