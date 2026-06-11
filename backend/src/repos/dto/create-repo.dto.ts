/**
 * create-repo.dto.ts
 *
 * DTO = Data Transfer Object: the typed, validated shape of an incoming request
 * body. The class-validator decorators are enforced by the global ValidationPipe
 * (configured in main.ts), so a request with a missing/invalid `url` is rejected
 * with a 400 before our controller code ever runs.
 */
import { IsString, Matches } from 'class-validator';

export class CreateRepoDto {
  @IsString()
  // Accept typical GitHub repo URLs (https form). Keeps obviously-wrong input out.
  @Matches(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/, {
    message: 'url must be a https://github.com/owner/repo link',
  })
  url!: string;
}
