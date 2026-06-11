/**
 * ask.dto.ts
 *
 * Validated body for POST /repos/:id/ask. A question must be a non-trivial
 * string; the global ValidationPipe enforces this before the controller runs.
 */
import { IsString, MinLength, MaxLength } from 'class-validator';

export class AskDto {
  @IsString()
  @MinLength(3, { message: 'question is too short' })
  @MaxLength(1000, { message: 'question is too long' })
  question!: string;
}
