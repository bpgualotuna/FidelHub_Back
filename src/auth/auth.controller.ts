import {
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import type { AuthUser } from './auth.types';

class LoginBodyDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

class LegacyLoginBodyDto {
  @IsString()
  @IsNotEmpty()
  phone!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

class RefreshTokenDto {
  @IsString()
  @IsNotEmpty()
  refresh_token!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  async login(@Body() dto: LoginBodyDto) {
    return this.authService.login({
      email: dto.email,
      password: dto.password,
    });
  }

  /** Compatibilidad MVP: teléfono + APP_LOGIN_PASSWORD → usuario legacy en seed */
  @Post('login-legacy')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  async loginLegacy(@Body() dto: LegacyLoginBodyDto) {
    return this.authService.loginLegacy({
      phone: dto.phone,
      password: dto.password,
    });
  }

  @Post('refresh')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  async refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshToken(dto.refresh_token);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: AuthUser) {
    return this.authService.getMe(user.userId);
  }
}
