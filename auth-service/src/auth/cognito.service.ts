import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  SignUpCommand,
  ConfirmSignUpCommand,
  GlobalSignOutCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
  AdminGetUserCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminConfirmSignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import axios from 'axios';
import * as crypto from 'crypto';

@Injectable()
export class CognitoService {
  private readonly client: CognitoIdentityProviderClient;
  private readonly userPoolId: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly googleClientId: string;

  constructor(private configService: ConfigService) {
    this.client = new CognitoIdentityProviderClient({
      region: this.configService.get('AWS_REGION') || 'us-east-1',
    });
    this.userPoolId = this.configService.get('COGNITO_USER_POOL_ID');
    this.clientId = this.configService.get('COGNITO_CLIENT_ID');
    this.clientSecret = this.configService.get('COGNITO_CLIENT_SECRET');
    this.googleClientId = this.configService.get('GOOGLE_CLIENT_ID');
  }

  private computeSecretHash(username: string): string | undefined {
    if (!this.clientSecret) return undefined;
    return crypto
      .createHmac('SHA256', this.clientSecret)
      .update(username + this.clientId)
      .digest('base64');
  }

  async signUp(email: string, password: string, firstName: string, lastName: string, phone?: string) {
    try {
      const params: any = {
        ClientId: this.clientId,
        Username: email,
        Password: password,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'given_name', Value: firstName },
          { Name: 'family_name', Value: lastName },
          { Name: 'name', Value: `${firstName} ${lastName}` },
        ],
      };
      if (phone) params.UserAttributes.push({ Name: 'phone_number', Value: phone });
      const hash = this.computeSecretHash(email);
      if (hash) params.SecretHash = hash;

      await this.client.send(new SignUpCommand(params));
      return { message: 'Signup successful. Check your email for a verification code.' };
    } catch (error) {
      if (error.name === 'UsernameExistsException') throw new ConflictException('Email already exists');
      throw new BadRequestException(error.message);
    }
  }

  async confirmSignUp(email: string, code: string) {
    try {
      const params: any = { ClientId: this.clientId, Username: email, ConfirmationCode: code };
      const hash = this.computeSecretHash(email);
      if (hash) params.SecretHash = hash;
      await this.client.send(new ConfirmSignUpCommand(params));
      return { message: 'Email confirmed. You can now log in.' };
    } catch (error) {
      if (error.name === 'CodeMismatchException') throw new BadRequestException('Invalid confirmation code');
      if (error.name === 'ExpiredCodeException') throw new BadRequestException('Confirmation code expired');
      throw new BadRequestException(error.message);
    }
  }

  async login(email: string, password: string) {
    try {
      const params: any = {
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: this.clientId,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      };
      const hash = this.computeSecretHash(email);
      if (hash) params.AuthParameters.SECRET_HASH = hash;

      const result = await this.client.send(new InitiateAuthCommand(params));
      const auth = result.AuthenticationResult;
      return {
        accessToken: auth.AccessToken,
        refreshToken: auth.RefreshToken,
        idToken: auth.IdToken,
        expiresIn: auth.ExpiresIn,
        cognitoUsername: email,
      };
    } catch (error) {
      if (error.name === 'NotAuthorizedException') throw new UnauthorizedException('Invalid email or password');
      if (error.name === 'UserNotConfirmedException') throw new BadRequestException('Please verify your email first');
      throw new BadRequestException(error.message);
    }
  }

  async refreshToken(refreshToken: string, cognitoUsername: string) {
    try {
      const params: any = {
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: this.clientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      };
      const hash = this.computeSecretHash(cognitoUsername);
      if (hash) params.AuthParameters.SECRET_HASH = hash;

      const result = await this.client.send(new InitiateAuthCommand(params));
      return { accessToken: result.AuthenticationResult.AccessToken };
    } catch (error) {
      throw new UnauthorizedException('Session expired. Please log in again.');
    }
  }

  async forgotPassword(email: string) {
    try {
      const params: any = { ClientId: this.clientId, Username: email };
      const hash = this.computeSecretHash(email);
      if (hash) params.SecretHash = hash;
      await this.client.send(new ForgotPasswordCommand(params));
      return { message: 'Password reset code sent to your email.' };
    } catch (error) {
      // Always return success to prevent email enumeration
      return { message: 'If that email exists, a reset code has been sent.' };
    }
  }

  async confirmForgotPassword(email: string, code: string, newPassword: string) {
    try {
      const params: any = {
        ClientId: this.clientId,
        Username: email,
        ConfirmationCode: code,
        Password: newPassword,
      };
      const hash = this.computeSecretHash(email);
      if (hash) params.SecretHash = hash;
      await this.client.send(new ConfirmForgotPasswordCommand(params));
      return { message: 'Password reset successfully.' };
    } catch (error) {
      if (error.name === 'CodeMismatchException') throw new BadRequestException('Invalid reset code');
      if (error.name === 'ExpiredCodeException') throw new BadRequestException('Reset code expired');
      throw new BadRequestException(error.message);
    }
  }

  async googleSignIn(googleIdToken: string) {
    try {
      const { data } = await axios.get(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${googleIdToken}`,
      );
      if (this.googleClientId && data.aud !== this.googleClientId) {
        throw new UnauthorizedException('Invalid Google token audience');
      }
      const { email, given_name, family_name, name, sub } = data;
      const firstName = given_name || name?.split(' ')[0] || 'User';
      const lastName = family_name || name?.split(' ').slice(1).join(' ') || '';
      const tempPassword = `Gg_${sub.slice(0, 10)}!1`;

      try {
        await this.client.send(
          new AdminGetUserCommand({ UserPoolId: this.userPoolId, Username: email }),
        );
      } catch (err) {
        if (err.name === 'UserNotFoundException') {
          await this.client.send(new AdminCreateUserCommand({
            UserPoolId: this.userPoolId,
            Username: email,
            UserAttributes: [
              { Name: 'email', Value: email },
              { Name: 'email_verified', Value: 'true' },
              { Name: 'given_name', Value: firstName },
              { Name: 'family_name', Value: lastName },
              { Name: 'name', Value: `${firstName} ${lastName}` },
            ],
            TemporaryPassword: tempPassword,
            MessageAction: 'SUPPRESS',
          }));
          await this.client.send(new AdminSetUserPasswordCommand({
            UserPoolId: this.userPoolId,
            Username: email,
            Password: tempPassword,
            Permanent: true,
          }));
        }
      }
      return this.login(email, tempPassword);
    } catch (error) {
      if (error instanceof UnauthorizedException || error instanceof BadRequestException) throw error;
      throw new UnauthorizedException('Google authentication failed: ' + error.message);
    }
  }

  async signOut(accessToken: string) {
    try {
      await this.client.send(new GlobalSignOutCommand({ AccessToken: accessToken }));
    } catch (_) {}
    return { message: 'Logged out successfully.' };
  }
}
