import { Hono } from 'hono'
import { z } from "zod"
import { validator } from "hono/validator"
import { OpenAIRequest, OpenAIResponse, OpenAIStreamResponse } from "./types"
import { streamSSE } from 'hono/streaming'
import { cors } from 'hono/cors'

// Enhanced logging function
const logger = {
  info: (message: string, data?: any) => {
    console.log(`[INFO] ${message}`, data ? JSON.stringify(data, null, 2) : '')
  },
  error: (message: string, error: any) => {
    console.error(`[ERROR] ${message}`, error)
  },
  debug: (message: string, data?: any) => {
    console.debug(`[DEBUG] ${message}`, data ? JSON.stringify(data, null, 2) : '')
  }
}

const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/102.0.0.0 Safari/537.36",
  "Accept": "text/event-stream",
  "Accept-Language": "de,en-US;q=0.7,en;q=0.3",
  "Accept-Encoding": "gzip, deflate, br",
  "Referer": "https://duckduckgo.com/?q=DuckDuckGo&ia=chat",
  "Content-Type": "application/json",
  "Origin": "https://duckduckgo.com",
  "Connection": "keep-alive",
  "Cookie": "dcm=1; bg=-1",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "Pragma": "no-cache",
  "TE": "trailers",
  "x-vqd-accept": "1",
  "cache-control": "no-store"
}

const statusURL = "https://duckduckgo.com/duckchat/v1/status"
const chatURL = "https://duckduckgo.com/duckchat/v1/chat"

// Updated schema to allow any model string
const schema = z.object({
  model: z.string(),
  messages: z.array(z.object({
    role: z.string(),
    content: z.string()
  })),
  stream: z.boolean().optional()
})

// Default supported models (but not limited to these)
const defaultModels = [
  "gpt-4o-mini",
  "claude-3-haiku-20240307",
  "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
  "mistralai/Mixtral-8x7B-Instruct-v0.1"
]

const app = new Hono()

app.use('/*', cors({
  origin: "*",
}))

const getXcqd4 = async function () {
  try {
    logger.debug('Fetching x-vqd-4 token')
    const res = await fetch(statusURL, {
      method: "GET",
      headers: headers,
    })
    const token = res.headers.get("x-vqd-4")
    logger.debug('Received x-vqd-4 token', { token })
    return token
  } catch (error) {
    logger.error('Error fetching x-vqd-4 token', error)
    throw error
  }
}

app.get('/', (c) => {
  logger.info('Received request to root endpoint')
  return c.text('Hello Hono!')
})

app.get("/v1/models", (c) => {
  logger.info('Fetching available models')
  const list = defaultModels.map(model => ({
    id: model,
    object: "model",
    created: 1686935002,
    owned_by: "duckduckgo-ai",
  }))
  
  return c.json({
    object: "list",
    data: list
  })
})

app.post("/v1/chat/completions", validator('json', (value, c) => {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    logger.error('Validation error', parsed.error)
    return c.json({error: parsed.error.errors[0].message}, 400)
  }
  return parsed.data
}), async (c) => {
  // @ts-ignore
  const apikey = c.env["apikey"] ?? ''
  
  // API key validation
  if (apikey) {
    const authorization = c.req.header("Authorization")
    if (!authorization) {
      logger.error('Missing authorization header')
      return c.json({"error": "authorization error"}, 401)
    }
    if (apikey !== authorization.substring(7)) {
      logger.error('Invalid API key')
      return c.json({"error": "apikey error"}, 401)
    }
  }

  const params = await c.req.json<OpenAIRequest>()
  logger.info('Received chat completion request', {
    model: params.model,
    messageCount: params.messages.length,
    stream: params.stream
  })

  const requestParams = {
    model: params.model,
    messages: params.messages.map(message => ({
      role: message.role === 'system' ? 'user' : message.role,
      content: message.content
    }))
  }

  try {
    let x4 = c.req.header("x-vqd-4")
    if (!x4) {
      x4 = await getXcqd4() || ""
    }
    if (!x4) {
      logger.error('Failed to obtain x-vqd-4 token')
      return c.json({error: "x-xqd-4 get error"}, 400)
    }

    logger.debug('Making request to DuckDuckGo API', {
      url: chatURL,
      vqd4: x4,
      model: params.model
    })

    const resp = await fetch(chatURL, {
      method: "POST",
      headers: {"x-vqd-4": x4, ...headers},
      body: JSON.stringify(requestParams)
    })

    if (!resp.ok) {
      const errorText = await resp.text()
      logger.error('DuckDuckGo API request failed', {
        status: resp.status,
        statusText: resp.statusText,
        error: errorText
      })
      return c.json({"error": "api request error", "message": errorText}, 400)
    }

    c.header("x-vqd-4", resp.headers.get("x-vqd-4") || "")

    if (params.stream) {
      logger.info('Starting SSE stream')
      return streamSSE(c, async (stream) => {
        if (!resp.body) {
          logger.error('No response body available for streaming')
          return
        }

        const reader = resp.body.getReader()
        let decoder = new TextDecoder()
        let buffer = ''

        try {
          while (true) {
            const {done, value} = await reader.read()
            if (done) {
              break
            }

            buffer += decoder.decode(value, {stream: true})
            const parts = buffer.split('\n')
            buffer = parts.pop() || ''

            for (let part of parts) {
              part = part.substring(6) // remove data:
              
              if (part === "[DONE]") {
                const openAIResponse = {
                  id: "chat-",
                  object: "chat.completion",
                  created: Date.now(),
                  model: params.model,
                  choices: [{
                    index: 0,
                    finish_reason: "stop",
                    content_filter_results: null,
                    delta: {}
                  }],
                  system_fingerprint: "fp_44709d6fcb"
                }

                await stream.writeSSE({ data: JSON.stringify(openAIResponse) })
                await stream.writeSSE({ data: "[DONE]" })
                logger.info('Stream completed')
                return
              }

              try {
                const response = JSON.parse(part)
                const openAIResponse: OpenAIStreamResponse = {
                  id: "chatcmpl-duckduck-ai",
                  object: "chat.completion",
                  created: Date.now() / 1000,
                  model: params.model,
                  choices: [{
                    index: 0,
                    delta: {
                      role: response["role"],
                      content: response["message"]
                    },
                    finish_reason: null,
                    content_filter_results: null,
                  }]
                }

                await stream.writeSSE({ data: JSON.stringify(openAIResponse) })
              } catch (error) {
                logger.error('Error parsing stream response', error)
              }
            }
          }
        } catch (error) {
          logger.error('Stream processing error', error)
        } finally {
          reader.releaseLock()
        }
      })
    }

    // Non-streaming response handling
    if (resp.body) {
      const buffer = await resp.text()
      let responseContent = ""
      
      const parts = buffer.split("\n\n")
      for (let part of parts) {
        part = part.substring(6)
        if (part === "[DONE]") {
          break
        }
        try {
          const parseJson = JSON.parse(part)
          responseContent += parseJson["message"] ?? ''
        } catch (error) {
          logger.error('Error parsing response part', error)
        }
      }

      const response: OpenAIResponse = {
        id: "chatcmpl-duckduck-ai",
        object: "chat.completion",
        created: Date.now() / 1000,
        model: params.model,
        system_fingerprint: "fp_44709d6fcb",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: responseContent,
          },
          logprobs: null,
          finish_reason: "stop"
        }],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      }

      logger.info('Request completed successfully', {
        model: params.model,
        responseLength: responseContent.length
      })

      return c.json(response)
    }
  } catch (error) {
    logger.error('Unexpected error in chat completion endpoint', error)
    return c.json({error: error}, 400)
  }
})

export default app
