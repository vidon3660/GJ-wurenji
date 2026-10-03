UPDATE resource_packages
SET manifest = jsonb_set(
  manifest,
  '{layers}',
  (
    SELECT jsonb_agg(
      CASE WHEN layer->>'code' = 'BUILDINGS' THEN
        jsonb_set(layer, '{features}', '[
          {"id":"GZ-NORTH-LOGISTICS-01-building-demo","name":"教学建筑","geometryType":"POLYGON","positions":[{"longitude":113.198,"latitude":23.387},{"longitude":113.199,"latitude":23.387},{"longitude":113.199,"latitude":23.388},{"longitude":113.198,"latitude":23.388}],"heightMeters":18,"properties":{"category":"BUILDING"}},
          {"id":"GZ-NORTH-LOGISTICS-01-obstacle-demo","name":"教学障碍物","geometryType":"POINT","position":{"longitude":113.201,"latitude":23.391},"heightMeters":8,"properties":{"category":"OBSTACLE"}}
        ]'::jsonb)
      ELSE layer END
    )
    FROM jsonb_array_elements(manifest->'layers') AS layer
  )
)
WHERE id = '20450ddf-89de-4d32-bde9-50c7be02d991';
