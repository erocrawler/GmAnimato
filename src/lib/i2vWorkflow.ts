import fs from 'fs/promises';
import path from 'path';

interface WorkflowParams {
  image_name: string;
  image_url: string;
  input_prompt: string;
  seed: number;
  callback_url?: string;
}

export async function buildWorkflow(params: WorkflowParams): Promise<object> {
  const templatePath = path.resolve('data/api_template.json.tmpl');
  let template = await fs.readFile(templatePath, 'utf-8');

  // Replace placeholders
  template = template.replace(/{image_name}/g, params.image_name);
  template = template.replace(/{image_url}/g, params.image_url);
  template = template.replace(/{input_prompt}/g, params.input_prompt);
  template = template.replace(/{seed}/g, String(params.seed));

  const workflow = JSON.parse(template);
  
  // Add callback_url to input if provided
  if (params.callback_url) {
    workflow.input.callback_url = params.callback_url;
  }

  return workflow;
}
