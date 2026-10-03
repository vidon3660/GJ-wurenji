import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from "typeorm"
import type { V3TeacherAlertFollowUpStatus } from "@wurenji/shared"

@Entity("teacher_alert_follow_ups")
@Unique("UQ_teacher_alert_follow_up_teacher_alert", ["teacherId", "alertId"])
@Index(["teacherId", "status"])
@Index(["alertId"])
export class TeacherAlertFollowUpEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @Column({ type: "uuid" }) teacherId!: string
  @Column({ type: "uuid" }) alertId!: string
  @Column({ type: "uuid" }) projectId!: string
  @Column({ type: "varchar", length: 20, default: "WATCHING" }) status!: V3TeacherAlertFollowUpStatus
  @Column({ type: "text", default: "" }) note!: string
  @CreateDateColumn() createdAt!: Date
  @UpdateDateColumn() updatedAt!: Date
}
