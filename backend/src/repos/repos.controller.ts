/**
 * repos.controller.ts
 *
 * HTTP surface for managing repositories:
 *   POST /repos        -> start indexing a GitHub repo (returns id + status)
 *   GET  /repos/:id    -> poll indexing status / metadata
 *
 * Controllers stay thin: validate input (via the DTO), delegate to the service,
 * return the result. No business logic lives here.
 */
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ReposService } from './repos.service';
import { CreateRepoDto } from './dto/create-repo.dto';

@Controller('repos')
export class ReposController {
  constructor(private readonly repos: ReposService) {}

  /** Kick off indexing. Body is validated against CreateRepoDto first. */
  @Post()
  create(@Body() dto: CreateRepoDto) {
    return this.repos.createRepo(dto.url);
  }

  /** Fetch a repo's current status (the frontend polls this while indexing). */
  @Get(':id')
  get(@Param('id') id: string) {
    return this.repos.getRepo(id);
  }
}
