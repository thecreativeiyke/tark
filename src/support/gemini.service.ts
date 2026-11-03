import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface UserContext {
  userName: string;
  userRole: string;
  walletBalance: number;
  activeJob?: {
    id: string;
    title: string;
    status: string;
    location: string;
    budget: number;
    tranche1Amount: number;
    tranche2Amount: number;
    otherPartyName?: string;
  };
  activeEscrow?: {
    id: string;
    status: string;
    t1Status: string;
    t2Status: string;
  };
}

export interface GeminiResponse {
  reply: string;
  needsEscalation: boolean;
  department?: string;
  priority?: string;
  succinctBrief?: string;
  frustrationScore?: number;
}

@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  constructor(private configService: ConfigService) {}

  private getApiKey(): string | null {
    return this.configService.get<string>('GEMINI_API_KEY') || null;
  }

  private getModel(): string {
    return this.configService.get<string>('GEMINI_MODEL', 'gemini-3.5-flash');
  }

  private getFallbackModel(): string {
    return this.configService.get<string>('GEMINI_FALLBACK_MODEL', 'gemini-2.5-flash');
  }

  async processMessage(
    userMessage: string,
    history: { role: 'user' | 'model'; parts: { text: string }[] }[],
    context: UserContext,
  ): Promise<GeminiResponse> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      this.logger.warn('GEMINI_API_KEY is not configured. Falling back to local rule-based assistant.');
      return this.localFallbackResponse(userMessage, context);
    }

    const systemInstruction = `
You are "Tark Assistant", the official, empathetic, and highly capable customer support agent for Tark — Nigeria's premier on-demand artisan and payment protection protocol.

USER CONTEXT:
- Name: ${context.userName}
- Role: ${context.userRole.toUpperCase()} (Client who hires, or Artisan who renders service)
- Wallet Balance: ₦${Number(context.walletBalance || 0).toLocaleString()}
${
  context.activeJob
    ? `- Active Service: "${context.activeJob.title}" (Status: ${context.activeJob.status})
- Agreed Budget: ₦${Number(context.activeJob.budget).toLocaleString()} (Part 1 Mobilization: ₦${Number(context.activeJob.tranche1Amount).toLocaleString()}, Part 2 Final: ₦${Number(context.activeJob.tranche2Amount).toLocaleString()})
- Counterparty: ${context.activeJob.otherPartyName || 'Assigned artisan/client'}`
    : '- No currently open job.'
}

COMMUNICATION GUIDELINES & VOCABULARY RULES:
1. Speak natural, warm, reassuring everyday English familiar to Nigerians. Be polite, direct, and concise. Avoid cold robotic corporate jargon.
2. ALWAYS use friendly terms:
   - DO NOT say "Escrow" -> Say "Tark Safe-Lock" or "Protected Escrow Payment" (money held safely by Tark).
   - DO NOT say "Tranche 1" -> Say "Start-Work Mobilization" or "First Part Payment".
   - DO NOT say "Tranche 2" -> Say "Final Completion Payment".
   - DO NOT say "Handshake PIN" -> Say "Job Completion Code".
   - DO NOT say "Dispute" -> Say "Resolution Request" or "Help Desk Ticket".
3. ESCALATION DETECTION (CRITICAL):
   Detect if the user is extremely frustrated or facing a serious issue:
   - Physical damage to property, theft, violence, threats, or abandoned jobs.
   - Explicit request for a human ("talk to human", "agent", "customer care", "call me").
   - Payment deductions without credit, or artisan demanding cash outside Tark.
4. RESPONSE FORMAT:
   Always structure your final output with a JSON envelope at the very end wrapped in:
   \`\`\`tark_meta
   {
     "needsEscalation": true/false,
     "department": "GENERAL_SUPPORT" | "DISPUTE_DESK" | "BILLING_AND_PAYMENTS" | "FRAUD_AND_SAFETY",
     "priority": "LOW" | "MEDIUM" | "HIGH" | "URGENT",
     "frustrationScore": 1 to 10,
     "succinctBrief": "A sharp, 2-3 sentence executive summary of the exact situation, verified facts, and recommended next action for the human officer."
   }
   \`\`\`
   Everything outside the tark_meta block is your conversational message directly shown to the user.
`.trim();

    const requestPayload = {
      systemInstruction: {
        parts: [{ text: systemInstruction }],
      },
      contents: [
        ...history,
        {
          role: 'user',
          parts: [{ text: userMessage }],
        },
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1000,
      },
    };

    // Try primary model first, fallback on error
    const primaryModel = this.getModel();
    const fallbackModel = this.getFallbackModel();

    try {
      return await this.callGeminiApi(primaryModel, apiKey, requestPayload);
    } catch (err: any) {
      this.logger.warn(`Primary model [${primaryModel}] error: ${err.message}. Retrying with [${fallbackModel}]...`);
      try {
        return await this.callGeminiApi(fallbackModel, apiKey, requestPayload);
      } catch (fallbackErr: any) {
        this.logger.error(`Fallback model [${fallbackModel}] failed: ${fallbackErr.message}`);
        return this.localFallbackResponse(userMessage, context);
      }
    }
  }

  private async callGeminiApi(model: string, apiKey: string, payload: any): Promise<GeminiResponse> {
    const url = `${this.baseUrl}/models/${model}:generateContent?key=${apiKey}`;
    const response = await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 12000,
    });

    const rawText =
      response.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      'I am here to assist you with Tark. How can I help?';

    return this.parseGeminiOutput(rawText);
  }

  private parseGeminiOutput(rawText: string): GeminiResponse {
    const metaRegex = /```tark_meta\s*([\s\S]*?)\s*```/;
    const match = rawText.match(metaRegex);

    let cleanReply = rawText.replace(metaRegex, '').trim();
    let meta: any = {
      needsEscalation: false,
      department: 'GENERAL_SUPPORT',
      priority: 'MEDIUM',
      frustrationScore: 2,
    };

    if (match && match[1]) {
      try {
        meta = JSON.parse(match[1]);
      } catch (e) {
        this.logger.warn('Failed to parse tark_meta JSON block from Gemini output');
      }
    }

    return {
      reply: cleanReply,
      needsEscalation: !!meta.needsEscalation,
      department: meta.department || 'GENERAL_SUPPORT',
      priority: meta.priority || 'MEDIUM',
      succinctBrief: meta.succinctBrief || null,
      frustrationScore: Number(meta.frustrationScore || 2),
    };
  }

  private localFallbackResponse(message: string, context: UserContext): GeminiResponse {
    const lower = message.toLowerCase();
    const isUrgent =
      lower.includes('damage') ||
      lower.includes('stole') ||
      lower.includes('police') ||
      lower.includes('cheat') ||
      lower.includes('scam') ||
      lower.includes('human') ||
      lower.includes('agent');

    if (isUrgent) {
      return {
        reply:
          `Hello ${context.userName}, I understand this is urgent. I have flagged your case and routed it directly to our senior Support and Dispute Desk. A human officer is reviewing your job details right now.`,
        needsEscalation: true,
        department: lower.includes('damage') || lower.includes('stole') ? 'FRAUD_AND_SAFETY' : 'DISPUTE_DESK',
        priority: 'URGENT',
        succinctBrief: `User ${context.userName} requested human intervention regarding urgent issue: "${message.slice(0, 150)}"`,
        frustrationScore: 8,
      };
    }

    return {
      reply:
        `Hello ${context.userName}! Welcome to Tark Support. Your payments are protected under Tark Safe-Lock until your service is satisfactorily completed. How can I assist you with your active job today?`,
      needsEscalation: false,
      department: 'GENERAL_SUPPORT',
      priority: 'LOW',
      frustrationScore: 1,
    };
  }
}
