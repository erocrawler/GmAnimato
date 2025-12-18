-- Seed default workflow with all compatible LoRAs
INSERT INTO "workflows" ("id", "name", "description", "templatePath", "compatible_lora_ids", "is_default", "created_at", "updated_at")
VALUES (
  'wan-2.2',
  'WAN 2.2',
  '原生 WAN 2.2 工作流+定制lora',
  'data/api_template.json.tmpl',
  '["wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors", "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors", "wan22-video10-arcshot-16-sel-7-high.safetensors", "DR34ML4Y_I2V_14B_HIGH.safetensors", "NSFW-22-H-e8.safetensors", "DR34ML4Y_I2V_14B_LOW.safetensors", "NSFW-22-L-e8.safetensors"]'::jsonb,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
