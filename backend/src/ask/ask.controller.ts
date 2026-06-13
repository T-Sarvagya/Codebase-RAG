/**
 * ask.controller.ts
 *
 * HTTP surface for asking questions:
 *   POST /repos/:id/ask          -> one-shot JSON answer (simple)
 *   POST /repos/:id/ask/stream   -> Server-Sent-Events stream (live tokens)
 *
 * Both are nested under a repo id, because every question is scoped to one
 * indexed repository.
 *
 * The streaming route writes SSE frames directly to the raw response with
 * @Res(), so we can flush tokens as they arrive instead of buffering the whole
 * answer. We deliberately use a POST (not the browser's GET-only EventSource)
 * so the question can travel in the request body; the frontend reads the stream
 * with fetch() + a ReadableStream reader.
 */
import { Body, Controller, Param, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { AskService } from './ask.service';
import { AskDto } from './dto/ask.dto';

@Controller('repos/:id/ask')
export class AskController {
  constructor(private readonly ask: AskService) {}

  /** One-shot answer — waits for the full response, returns JSON. */
  @Post()
  askQuestion(@Param('id') repoId: string, @Body() dto: AskDto) {
    return this.ask.ask(repoId, dto.question);
  }

  /** Streaming answer — emits SSE frames: `sources`, many `token`s, then `done`. */
  @Post('stream')
  async stream(
    @Param('id') repoId: string,
    @Body() dto: AskDto,
    @Res() res: Response,
  ): Promise<void> {
    // Standard SSE headers. `X-Accel-Buffering: no` stops some proxies from
    // buffering the stream (so tokens actually arrive incrementally).
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // Each event is one `event:`/`data:` frame terminated by a blank line.
    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      for await (const ev of this.ask.streamAnswer(repoId, dto.question)) {
        send(ev.type, ev.data);
      }
    } catch (err) {
      // prepare()/retrieval failed before streaming started — report and close.
      const message = err instanceof Error ? err.message : 'Stream failed';
      send('error', { message });
    } finally {
      res.end();
    }
  }
}
