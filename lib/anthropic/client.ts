import Anthropic from '@anthropic-ai/sdk';

if (!process.env.ANTHROPIC_API_KEY) {
  // Soft warn — only fail when a method is called.
  console.warn('[anthropic] ANTHROPIC_API_KEY not set. Calls will fail until configured.');
}

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
});

export const DEFAULT_MODEL = 'claude-sonnet-4-6';
