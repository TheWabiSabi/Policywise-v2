import { IsEmail, IsString, MinLength, IsOptional, IsNotEmpty } from 'class-validator';

export class SignUpDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  first_name: string;

  @IsString()
  @IsNotEmpty()
  last_name: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsOptional()
  @IsString()
  phone?: string;
}

export class ConfirmSignupDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  code: string;
}

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;
}

export class ForgotPasswordDto {
  @IsEmail()
  email: string;
}

export class ConfirmForgotPasswordDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  code: string;

  @IsString()
  @MinLength(8)
  new_password: string;
}
