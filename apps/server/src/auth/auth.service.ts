import { Injectable, UnauthorizedException } from "@nestjs/common"
import { JwtService } from "@nestjs/jwt"
import { InjectRepository } from "@nestjs/typeorm"
import { compare } from "bcryptjs"
import { Repository } from "typeorm"
import type { AuthUser } from "@wurenji/shared"
import { UserEntity } from "../entities.js"

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly jwt: JwtService
  ) {}

  async login(email: string, password: string): Promise<{ token: string; user: AuthUser }> {
    const user = await this.users.findOne({ where: { email: email.trim().toLowerCase() } })
    if (!user || !(await compare(password, user.passwordHash))) {
      throw new UnauthorizedException("邮箱或密码错误")
    }
    const authUser = this.toAuthUser(user)
    return { token: await this.jwt.signAsync(authUser), user: authUser }
  }

  async verify(token: string): Promise<AuthUser> {
    try {
      return await this.jwt.verifyAsync<AuthUser>(token)
    } catch {
      throw new UnauthorizedException("登录已失效")
    }
  }

  toAuthUser(user: UserEntity): AuthUser {
    return { id: user.id, email: user.email, displayName: user.displayName, role: user.role }
  }
}
