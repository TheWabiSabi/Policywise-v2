import {
  Controller,
  Post,
  Body,
  Get,
  UseGuards,
  Request,
  Response,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import {
  SignUpDto,
  ConfirmSignupDto,
  LoginDto,
  ForgotPasswordDto,
  ConfirmForgotPasswordDto,
} from './dto/auth.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  private get cookieOpts() {
    const isProd = this.configService.get('NODE_ENV') === 'production';
    return {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? ('strict' as const) : ('lax' as const),
      path: '/',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    };
  }

  /** POST /auth/signup — register, triggers OTP email */
  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  async signUp(@Body() dto: SignUpDto) {
    return this.authService.signUp(
      dto.email, dto.password, dto.first_name, dto.last_name, dto.phone,
    );
  }

  /** POST /auth/confirm — verify OTP from email */
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(@Body() dto: ConfirmSignupDto) {
    return this.authService.confirmSignUp(dto.email, dto.code);
  }

  /** POST /auth/login — returns access_token in body, sets httpOnly cookies */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Response({ passthrough: true }) res: any) {
    const result = await this.authService.login(dto.email, dto.password);
    // Set refresh_token + cognito_username as httpOnly cookies
    res.cookie('refresh_token', result.refreshToken, this.cookieOpts);
    res.cookie('cognito_username', result.cognitoUsername, this.cookieOpts);
    return {
      statusCode: 200,
      message: 'Login successful.',
      access_token: result.accessToken,
    };
  }

  /** POST /auth/refresh — no body, reads httpOnly cookie */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Request() req: any, @Response({ passthrough: true }) res: any) {
    const refreshToken = req.cookies?.refresh_token;
    const cognitoUsername = req.cookies?.cognito_username;
    if (!refreshToken || !cognitoUsername) {
      throw new UnauthorizedException('No refresh token cookie found');
    }
    const result = await this.authService.refreshToken(refreshToken, cognitoUsername);
    return { access_token: result.accessToken };
  }

  /** GET /auth/profile — returns current user from JWT */
  @UseGuards(JwtAuthGuard)
  @Get('profile')
  getProfile(@Request() req: any) {
    return req.user;
  }

  /** POST /auth/logout — clears cookies + invalidates Cognito session */
  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Request() req: any, @Response({ passthrough: true }) res: any) {
    const token = req.headers.authorization?.split(' ')[1];
    const clearOpts = { ...this.cookieOpts, maxAge: 0 };
    res.cookie('refresh_token', '', clearOpts);
    res.cookie('cognito_username', '', clearOpts);
    return this.authService.signOut(token);
  }

  /** POST /auth/google — Google ID token exchange */
  @Post('google')
  @HttpCode(HttpStatus.OK)
  async googleAuth(@Body() body: { idToken: string }, @Response({ passthrough: true }) res: any) {
    const result = await this.authService.googleAuth(body.idToken);
    res.cookie('refresh_token', result.refreshToken, this.cookieOpts);
    res.cookie('cognito_username', result.cognitoUsername, this.cookieOpts);
    return { statusCode: 200, message: 'Login successful.', access_token: result.accessToken };
  }

  /** POST /auth/forgot-password */
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  /** POST /auth/forgot-password/confirm */
  @Post('forgot-password/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmForgotPassword(@Body() dto: ConfirmForgotPasswordDto) {
    return this.authService.confirmForgotPassword(dto.email, dto.code, dto.new_password);
  }
}
