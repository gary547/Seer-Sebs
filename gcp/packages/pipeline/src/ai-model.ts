export const PIPELINE_AI_MODEL = "deepseek/deepseek-v4.1-flash";
export const PIPELINE_AI_MODEL_LABEL = "DeepSeek V4.1 Flash";
export const LEGACY_PIPELINE_AI_MODEL = "z-ai/glm-5.3-flash";
export type PipelineAiModel = typeof PIPELINE_AI_MODEL | typeof LEGACY_PIPELINE_AI_MODEL;
