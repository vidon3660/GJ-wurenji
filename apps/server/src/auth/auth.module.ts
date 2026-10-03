import { Module } from "@nestjs/common"
import { JwtModule } from "@nestjs/jwt"
import { randomBytes } from "node:crypto"
import { TypeOrmModule } from "@nestjs/typeorm"
import { UserEntity } from "../entities.js"
import { AuthController } from "./auth.controller.js"
import { AuthGuard } from "./auth.guard.js"
import { AuthService } from "./auth.service.js"

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity]),
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET ?? randomBytes(32).toString("hex"),
      signOptions: { expiresIn: "8h" }
    })
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard],
  exports: [AuthService, AuthGuard]
})
export class AuthModule {}
