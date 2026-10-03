UPDATE resource_packages
SET manifest = jsonb_set(
  manifest,
  '{boundary}',
  (SELECT jsonb_agg(point) FROM jsonb_array_elements(manifest->'boundary') WITH ORDINALITY AS item(point, ordinal) WHERE ordinal <= 4)
)
WHERE id = '6b1315e7-1934-416f-bed9-6ed3cd5372c1';
