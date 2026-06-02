import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CognitoService } from './cognito.service';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    ConfigModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, CognitoService, JwtStrategy],
  exports: [AuthService, CognitoService, JwtStrategy],
})
export class AuthModule {}
