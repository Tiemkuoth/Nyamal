export type ProviderProtocol = "openai-compatible" | "gemini" | "anthropic" | "cohere" | "azure-openai";

export interface ProviderPreset {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  base_url: string;
  auth_header: string;
  auth_prefix: string;
  model_list_path: string | null;
  api_version: string | null;
  note?: string;
}

const compatible = (
  id: string,
  name: string,
  base_url: string,
  model_list_path = "/models",
): ProviderPreset => ({
  id,
  name,
  protocol: "openai-compatible",
  base_url,
  auth_header: "Authorization",
  auth_prefix: "Bearer ",
  model_list_path,
  api_version: null,
});

export const PROVIDER_PRESETS: ProviderPreset[] = [
  compatible("openai", "OpenAI", "https://api.openai.com/v1"),
  {
    id: "anthropic", name: "Anthropic Claude", protocol: "anthropic",
    base_url: "https://api.anthropic.com/v1", auth_header: "x-api-key",
    auth_prefix: "", model_list_path: "/models", api_version: "2023-06-01",
  },
  {
    id: "gemini", name: "Google Gemini", protocol: "gemini",
    base_url: "https://generativelanguage.googleapis.com/v1beta", auth_header: "x-goog-api-key",
    auth_prefix: "", model_list_path: "/models", api_version: null,
  },
  compatible("deepseek", "DeepSeek", "https://api.deepseek.com/v1"),
  compatible("groq", "Groq", "https://api.groq.com/openai/v1"),
  compatible("mistral", "Mistral AI", "https://api.mistral.ai/v1"),
  compatible("xai", "xAI Grok", "https://api.x.ai/v1"),
  compatible("qwen", "Qwen DashScope", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
  {
    id: "cohere", name: "Cohere", protocol: "cohere",
    base_url: "https://api.cohere.com", auth_header: "Authorization",
    auth_prefix: "Bearer ", model_list_path: "/v1/models", api_version: null,
  },
  compatible("perplexity", "Perplexity", "https://api.perplexity.ai"),
  compatible("together", "Together AI", "https://api.together.xyz/v1"),
  compatible("fireworks", "Fireworks AI", "https://api.fireworks.ai/inference/v1"),
  compatible("openrouter", "OpenRouter", "https://openrouter.ai/api/v1"),
  compatible("huggingface", "Hugging Face Inference", "https://router.huggingface.co/v1"),
  compatible("cerebras", "Cerebras", "https://api.cerebras.ai/v1"),
  compatible("nvidia-nim", "NVIDIA NIM", "https://integrate.api.nvidia.com/v1"),
  compatible("sambanova", "SambaNova", "https://api.sambanova.ai/v1"),
  {
    id: "azure-openai", name: "Azure OpenAI", protocol: "azure-openai",
    base_url: "https://YOUR-RESOURCE.openai.azure.com", auth_header: "api-key",
    auth_prefix: "", model_list_path: "/openai/deployments", api_version: "",
    note: "Enter the Azure resource URL and a deployments API version.",
  },
  {
    id: "custom", name: "Custom OpenAI-compatible API", protocol: "openai-compatible",
    base_url: "", auth_header: "Authorization", auth_prefix: "Bearer ",
    model_list_path: "/models", api_version: null,
    note: "The HTTPS endpoint must be publicly reachable from Cloudflare Workers.",
  },
];

export const PROVIDER_LIMITATIONS = [
  "Meta Llama is a model family; select a provider that serves the model.",
  "Ollama and LM Studio work only when their OpenAI-compatible HTTPS endpoint is publicly reachable; localhost is not reachable from a Cloudflare Worker.",
  "Amazon Bedrock's AWS SigV4 request signing is not implemented by this Worker.",
];
