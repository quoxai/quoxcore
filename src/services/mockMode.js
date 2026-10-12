/**
 * Mock Mode Service
 *
 * Provides mock responses for external services when running in demo mode.
 * Enable with VITE_DEMO_MODE=true environment variable.
 *
 * This allows QuoxCORE to run without any API keys for evaluation purposes:
 * - Mock Claude API responses with realistic delays
 * - Mock Stripe for development/testing
 * - Mock workflow execution
 */

// Check if demo mode is enabled
export const isDemoMode = () => {
    return import.meta.env.VITE_DEMO_MODE === 'true'
}

// Simulate network delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// Random delay between min and max ms
const randomDelay = (min = 500, max = 2000) => {
    return delay(Math.random() * (max - min) + min)
}

/**
 * Mock Claude API Responses
 */
const MOCK_CLAUDE_RESPONSES = [
    {
        patterns: [/hello|hi|hey|greetings/i],
        responses: [
            "Hello! I'm running in demo mode. While I can demonstrate the interface, real AI capabilities require a configured model provider such as OpenAI or Anthropic. How can I help you explore QuoxCORE?",
            "Hi there! Demo mode is active - I can show you around the system. What would you like to explore?",
        ]
    },
    {
        patterns: [/status|health|system/i],
        responses: [
            "**System Status (Demo Mode)**\n\nAll services are simulated:\n- Dashboard: Online\n- Auth: Online\n- Collector: Simulated\n- Qdrant: Simulated\n\nTo enable full functionality, add your API keys in Settings.",
        ]
    },
    {
        patterns: [/help|what can you do|capabilities/i],
        responses: [
            "**QuoxCORE Demo Mode**\n\nIn demo mode, I can help you:\n\n1. **Explore the Interface** - Navigate through all sections\n2. **View Sample Data** - See how data appears\n3. **Test Workflows** - Understand the workflow builder\n4. **Learn the System** - Get familiar with QuoxCORE\n\nFor real operations, you'll need to configure:\n- OpenAI or Anthropic API key (for chat and model routing)\n- OpenAI API key (for embeddings if you want semantic memory search)\n- QuoxFlow workflows (for automation)",
        ]
    },
    {
        patterns: [/deploy|install|mha|agent/i],
        responses: [
            "**MHA Agent Deployment (Demo)**\n\nIn production mode, I would:\n1. Connect to the target host via SSH\n2. Download and install the MHA agent\n3. Configure it to report to the collector\n4. Verify the connection\n\nDemo mode cannot perform actual deployments. Enable production mode by configuring your infrastructure in Settings.",
        ]
    },
    {
        patterns: [/memory|remember|recall/i],
        responses: [
            "**Memory System (Demo)**\n\nThe memory system supports:\n- **Episodic Memory**: Conversation history\n- **Semantic Memory**: Facts and knowledge\n- **Entity Memory**: People, places, systems\n- **Working Set**: Active context\n\nIn demo mode, memories are stored locally but vector search requires an OpenAI key for embeddings.",
        ]
    },
    {
        patterns: [/.*/],
        responses: [
            "I understand you're asking about: \"{{query}}\"\n\nIn demo mode, I provide simulated responses. For real AI assistance, please configure an OpenAI or Anthropic API key in Settings → API Keys.",
            "**Demo Mode Response**\n\nYour query: \"{{query}}\"\n\nThis is a simulated response. Real model integration requires an API key. Would you like to:\n1. Continue exploring the demo\n2. Learn how to configure API keys\n3. See what features are available",
        ]
    }
]

/**
 * Generate a mock Claude API response
 */
export async function mockClaudeResponse(query) {
    if (!isDemoMode()) {
        throw new Error('Mock mode not enabled')
    }

    // Simulate thinking time
    await randomDelay(800, 2500)

    // Find matching response pattern
    for (const entry of MOCK_CLAUDE_RESPONSES) {
        for (const pattern of entry.patterns) {
            if (pattern.test(query)) {
                const response = entry.responses[Math.floor(Math.random() * entry.responses.length)]
                return response.replace('{{query}}', query)
            }
        }
    }

    // Fallback (should never reach due to .* pattern)
    return `Demo mode response for: ${query}`
}

/**
 * Mock Stripe API
 */
export const mockStripe = {
    async createCheckoutSession(priceId, successUrl, cancelUrl) {
        if (!isDemoMode()) throw new Error('Mock mode not enabled')
        await randomDelay(500, 1000)

        return {
            id: `demo_cs_${Date.now()}`,
            url: `${window.location.origin}/demo-checkout?price=${priceId}`,
            status: 'open',
            mode: 'payment',
        }
    },

    async retrieveSession(sessionId) {
        if (!isDemoMode()) throw new Error('Mock mode not enabled')
        await randomDelay(300, 600)

        return {
            id: sessionId,
            status: 'complete',
            payment_status: 'paid',
            customer_email: 'demo@example.com',
            metadata: {
                demo: true
            }
        }
    },

    async listProducts() {
        if (!isDemoMode()) throw new Error('Mock mode not enabled')
        await randomDelay(400, 800)

        return {
            data: [
                { id: 'prod_demo_1', name: 'Advanced Memory', price: 1999 },
                { id: 'prod_demo_2', name: 'MHA Fleet', price: 4999 },
                { id: 'prod_demo_3', name: 'AOCL Compliance', price: 2999 },
            ]
        }
    }
}

/**
 * Mock OpenAI Embeddings
 */
export const mockEmbeddings = {
    async createEmbedding(text) {
        if (!isDemoMode()) throw new Error('Mock mode not enabled')
        await randomDelay(200, 500)

        // Generate a fake embedding vector (1536 dimensions like text-embedding-ada-002)
        const embedding = Array.from({ length: 1536 }, () => Math.random() * 2 - 1)

        return {
            data: [{
                embedding,
                index: 0,
            }],
            model: 'demo-embedding',
            usage: {
                prompt_tokens: text.split(' ').length,
                total_tokens: text.split(' ').length,
            }
        }
    },

    async batchCreateEmbeddings(texts) {
        if (!isDemoMode()) throw new Error('Mock mode not enabled')
        await randomDelay(500, 1500)

        return {
            data: texts.map((text, index) => ({
                embedding: Array.from({ length: 1536 }, () => Math.random() * 2 - 1),
                index,
            })),
            model: 'demo-embedding',
        }
    }
}

/**
 * Mock Qdrant Vector Database
 */
export const mockQdrant = {
    async search(collection, vector, limit = 10) {
        if (!isDemoMode()) throw new Error('Mock mode not enabled')
        await randomDelay(100, 300)

        // Return mock search results
        return Array.from({ length: Math.min(limit, 5) }, (_, i) => ({
            id: `demo_${i}`,
            score: 0.95 - (i * 0.1),
            payload: {
                text: `Demo search result ${i + 1}`,
                type: 'demo',
                timestamp: new Date(Date.now() - i * 86400000).toISOString(),
            }
        }))
    },

    async upsert(collection, points) {
        if (!isDemoMode()) throw new Error('Mock mode not enabled')
        await randomDelay(100, 200)

        return {
            status: 'ok',
            result: {
                operation_id: `demo_op_${Date.now()}`,
                status: 'completed'
            }
        }
    },

    async getCollections() {
        if (!isDemoMode()) throw new Error('Mock mode not enabled')
        await randomDelay(50, 150)

        return {
            collections: [
                { name: 'memories', vectors_count: 1234 },
                { name: 'entities', vectors_count: 567 },
                { name: 'files', vectors_count: 89 },
            ]
        }
    }
}

/**
 * Demo Mode Banner Component (can be imported in React)
 */
export const getDemoBannerText = () => {
    return "Demo Mode - API keys not configured. Some features are simulated."
}

/**
 * Check if a specific feature requires real API
 */
export const requiresRealAPI = (feature) => {
    const features = {
        chat: 'Anthropic API key',
        embeddings: 'OpenAI API key',
        vectorSearch: 'OpenAI API key',
        payments: 'Stripe API key',
        workflows: 'QuoxFlow connection',
        hostManagement: 'SSH/MHA configuration',
    }
    return features[feature] || null
}

export default {
    isDemoMode,
    mockClaudeResponse,
    mockStripe,
    mockEmbeddings,
    mockQdrant,
    getDemoBannerText,
    requiresRealAPI,
}
