import type { MigrationInterface, QueryRunner } from "typeorm"

export class R13V3ProjectStageBackfill1787875200000 implements MigrationInterface {
  name = "R13V3ProjectStageBackfill1787875200000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      WITH stage_definitions (scene_type, stage_code, sequence) AS (
        VALUES
          ('CITY_SHOW', 'SHOW_AREA_PLANNING', 1),
          ('CITY_SHOW', 'SHOW_FLIGHT_APPLICATION', 2),
          ('CITY_SHOW', 'SHOW_PREFLIGHT', 3),
          ('CITY_SHOW', 'SHOW_T_MINUS_60', 4),
          ('CITY_SHOW', 'SHOW_RUNTIME', 5),
          ('CITY_SHOW', 'SHOW_FLIGHT_END_REPORT', 6),
          ('CITY_SHOW', 'SHOW_REVIEW', 7),
          ('CITY_LOGISTICS', 'LOGISTICS_REGION_ANALYSIS', 1),
          ('CITY_LOGISTICS', 'LOGISTICS_ROUTE_PLANNING', 2),
          ('CITY_LOGISTICS', 'LOGISTICS_ROUTE_VALIDATION', 3),
          ('CITY_LOGISTICS', 'LOGISTICS_ORDER_SCHEDULING', 4),
          ('CITY_LOGISTICS', 'LOGISTICS_RUNTIME_PREPARATION', 5),
          ('CITY_LOGISTICS', 'LOGISTICS_DELIVERY_RUNTIME', 6),
          ('CITY_LOGISTICS', 'LOGISTICS_EMERGENCY_HANDLING', 7),
          ('CITY_LOGISTICS', 'LOGISTICS_REVIEW', 8),
          ('VTOL_INSPECTION', 'VTL_AREA_OBJECTS', 1),
          ('VTOL_INSPECTION', 'VTL_TASK_ALLOCATION', 2),
          ('VTOL_INSPECTION', 'VTL_ROUTE_PLANNING', 3),
          ('VTOL_INSPECTION', 'VTL_PLAN_VALIDATION', 4),
          ('VTOL_INSPECTION', 'VTL_EXECUTION_PLAN', 5),
          ('VTOL_INSPECTION', 'VTL_RUNTIME', 6),
          ('VTOL_INSPECTION', 'VTL_EMERGENCY_HANDLING', 7),
          ('VTOL_INSPECTION', 'VTL_REVIEW', 8)
      ),
      projects_to_backfill AS (
        SELECT
          project."id",
          project."status",
          project."currentStageCode",
          snapshot."sceneType"
        FROM "student_projects" project
        INNER JOIN "assignment_snapshots" snapshot
          ON snapshot."id" = project."snapshotId"
        INNER JOIN stage_definitions current_stage
          ON current_stage.scene_type = snapshot."sceneType"
         AND current_stage.stage_code = project."currentStageCode"
        WHERE NOT EXISTS (
          SELECT 1
          FROM "student_project_stages" existing_stage
          WHERE existing_stage."projectId" = project."id"
        )
      )
      INSERT INTO "student_project_stages" (
        "id",
        "stageCode",
        "sequence",
        "status",
        "revision",
        "submittedAt",
        "acceptedAt",
        "returnedAt",
        "updatedAt",
        "projectId"
      )
      SELECT
        uuid_generate_v4(),
        definition.stage_code,
        definition.sequence,
        CASE
          WHEN definition.sequence < current_definition.sequence THEN 'ACCEPTED'
          WHEN definition.sequence > current_definition.sequence THEN 'LOCKED'
          WHEN project.status = 'NOT_STARTED' THEN 'AVAILABLE'
          WHEN project.status = 'SUBMITTED' THEN 'SUBMITTED'
          ELSE 'IN_PROGRESS'
        END,
        1,
        NULL,
        NULL,
        NULL,
        CURRENT_TIMESTAMP,
        project.id
      FROM projects_to_backfill project
      INNER JOIN stage_definitions definition
        ON definition.scene_type = project."sceneType"
      INNER JOIN stage_definitions current_definition
        ON current_definition.scene_type = project."sceneType"
       AND current_definition.stage_code = project."currentStageCode"
    `)
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
