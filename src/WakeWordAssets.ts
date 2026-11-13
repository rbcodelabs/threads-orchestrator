/**
 * Always pulls the wake-word ONNX models from whichever release is tagged
 * "latest" on this repository, so every published release must attach
 * melspectrogram.onnx, embedding_model.onnx and hey_obsidian.onnx
 * (see .github/workflows/release.yml).
 */
export const MODEL_RELEASE_BASE_URL =
  'https://github.com/rbcodelabs/threads-orchestrator/releases/latest/download';
