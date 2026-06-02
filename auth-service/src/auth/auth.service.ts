import { Injectable } from '@nestjs/common';
import { CognitoService } from './cognito.service';

@Injectable()
export class AuthService {
  constructor(private readonly cognitoService: CognitoService) {}

  signUp(email: string, password: string, firstName: string, lastName: string, phone?: string) {
    return this.cognitoService.signUp(email, password, firstName, lastName, phone);
  }

  confirmSignUp(email: string, code: string) {
    return this.cognitoService.confirmSignUp(email, code);
  }

  login(email: string, password: string) {
    return this.cognitoService.login(email, password);
  }

  refreshToken(refreshToken: string, cognitoUsername: string) {
    return this.cognitoService.refreshToken(refreshToken, cognitoUsername);
  }

  forgotPassword(email: string) {
    return this.cognitoService.forgotPassword(email);
  }

  confirmForgotPassword(email: string, code: string, newPassword: string) {
    return this.cognitoService.confirmForgotPassword(email, code, newPassword);
  }

  googleAuth(idToken: string) {
    return this.cognitoService.googleSignIn(idToken);
  }

  signOut(accessToken: string) {
    return this.cognitoService.signOut(accessToken);
  }
}
