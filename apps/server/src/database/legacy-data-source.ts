import "reflect-metadata"
import { DataSource } from "typeorm"
import { entities } from "../entities.js"
import { educationEntities } from "../education/education.entities.js"
import { logisticsEntities } from "../logistics/logistics.entities.js"
import { scenarioOverlayEntities } from "../v3/resources/scenario-overlay.entity.js"

export const LegacyDataSource = new DataSource({
  type: "postgres",
  url: process.env.DATABASE_URL ?? "postgresql://wurenji@localhost:55432/wurenji",
  entities: [...entities, ...educationEntities, ...logisticsEntities, ...scenarioOverlayEntities],
  migrations: [],
  synchronize: false,
  logging: false
})
