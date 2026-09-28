#!/usr/bin/env bash
# Starts a free model on this Linux x64 machine for AEE's AI suggestions: Ollama, pinned and
# checksummed, serving AEE_LLM_MODEL (the local provider's default when unset) where the local
# provider looks for it. No key is needed, and page evidence never leaves the machine.
# Run it after AEE is built; it returns once the model is loaded and ready for questions.
set -euo pipefail

OLLAMA_VERSION=v0.34.4
OLLAMA_SHA256=c238986e61d40c0cc5f4a9b9e40b9eea104350b77efa34741fc134e105cb9533
OLLAMA_URL=http://127.0.0.1:11434

if [ "$(uname -sm)" != "Linux x86_64" ]; then
  echo "::error::The local model needs a Linux x64 runner; this one is $(uname -sm)." >&2
  exit 1
fi

cd "$(dirname "$0")/.."
model="${AEE_LLM_MODEL:-$(node -p 'require("@aee/ai-fixes").DEFAULT_LOCAL_MODEL')}"
dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ollama"
mkdir -p "$dir"

curl -fsSL --retry 3 -o "$dir/ollama.tar.zst" \
  "https://github.com/ollama/ollama/releases/download/$OLLAMA_VERSION/ollama-linux-amd64.tar.zst"
echo "$OLLAMA_SHA256  $dir/ollama.tar.zst" | sha256sum --check --quiet
# The GPU libraries are 2 GB of the 2.2 GB, and a runner has no GPU.
tar --zstd -xf "$dir/ollama.tar.zst" -C "$dir" --exclude='cuda_v*' --exclude=vulkan
rm "$dir/ollama.tar.zst"

# The prompt is about 3,000 tokens, too close to the CPU default window of 4,096; the model stays
# loaded for the whole run; and Ollama's cloud models are off, so no model name can send evidence
# off the machine.
OLLAMA_CONTEXT_LENGTH=8192 OLLAMA_KEEP_ALIVE=-1 OLLAMA_NO_CLOUD=1 nohup "$dir/bin/ollama" serve > "$dir/serve.log" 2>&1 &
trap 'echo; tail -n 20 "$dir/serve.log"' ERR
for _ in $(seq 30); do
  curl -fsS "$OLLAMA_URL/api/version" > /dev/null 2>&1 && break
  sleep 1
done

curl -sS --fail-with-body "$OLLAMA_URL/api/pull" -d "{\"model\":\"$model\",\"stream\":false}"
# Loading it now spares the first question the wait.
curl -fsS "$OLLAMA_URL/api/generate" -d "{\"model\":\"$model\"}" > /dev/null
echo
echo "$model is ready at $OLLAMA_URL after ${SECONDS}s."
