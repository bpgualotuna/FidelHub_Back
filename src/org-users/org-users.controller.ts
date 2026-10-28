import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { OrgMemberGuard } from '../auth/org-member.guard';
import { OrgUsersService } from './org-users.service';

class CreateOrgUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsOptional()
  @IsString()
  displayName?: string;

  @IsIn([UserRole.AGENT, UserRole.ORG_ADMIN])
  role!: UserRole;
}

@Controller('org/users')
@UseGuards(JwtAuthGuard, OrgMemberGuard, RolesGuard)
@Roles(UserRole.ORG_ADMIN)
export class OrgUsersController {
  constructor(private readonly orgUsers: OrgUsersService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('assignable') assignable?: string) {
    return this.orgUsers.list(user.organizationId!, assignable === 'true');
  }

  @Post()
  @UsePipes(new ValidationPipe({ whitelist: true }))
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateOrgUserDto) {
    return this.orgUsers.create(user.organizationId!, {
      email: dto.email,
      password: dto.password,
      displayName: dto.displayName,
      role: dto.role,
    });
  }

  @Patch(':id/deactivate')
  deactivate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.orgUsers.deactivate(user.organizationId!, id, user.userId);
  }

  @Patch(':id/reactivate')
  reactivate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.orgUsers.reactivate(user.organizationId!, id);
  }
}
