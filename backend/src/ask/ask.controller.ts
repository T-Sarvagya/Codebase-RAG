/**
 * ask.controller.ts
 *
 * HTTP surface for asking questions:
 *   POST /repos/:id/ask   body: { question }   -> { answer, citations, grounded }
 *
 * Note the route is nested under a repo id, because every question is scoped to
 * one indexed repository.
 */
import { Body, Controller, Param, Post } from '@nestjs/common';
import { AskService } from './ask.service';
import { AskDto } from './dto/ask.dto';

@Controller('repos/:id/ask')
export class AskController {
  constructor(private readonly ask: AskService) {}

  @Post()
  askQuestion(@Param('id') repoId: string, @Body() dto: AskDto) {
    return this.ask.ask(repoId, dto.question);
  }
}
