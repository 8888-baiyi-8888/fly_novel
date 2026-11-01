import { defineTool } from '@fly-novel/tools'
import { FilesystemSkillProvider } from '@fly-novel/skill-filesystem'
import { SkillService } from '@fly-novel/skill'

/**
 * 创建按名称加载 Skill 的工具。
 * @param root 可信调用方提供的绝对 Skill 根目录，运行时须位于授权工作目录中。
 * @returns 可注册到 ToolsService 的 `skill` 工具。
 * @throws 根目录不是绝对路径时抛错；加载失败以工具执行错误返回。
 */
export function createSkillTool(root: string) {
  const skills = new SkillService()
  skills.registerProvider(new FilesystemSkillProvider(root))
  return defineTool({
    name: 'skill',
    description: '按名称加载可用 Skill 的完整指导内容',
    parameters: {
      name: { type: 'string', required: true, description: '可用 Skill 的准确名称' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          resourceBase: {
            type: 'object', required: true, additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'directory' },
              path: { type: 'string', required: true },
            },
          },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: [
        `<skill_content name="${escapeText(value.name)}">`,
        '<skill_resources>',
        `Base directory for this skill: ${escapeText(value.resourceBase.path)}`,
        'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
        '</skill_resources>',
        '',
        '<skill_instructions>',
        value.content,
        '</skill_instructions>',
        '</skill_content>',
      ].join('\n') }],
    },
    execute: async (args, exec) => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.name)) throw new Error('Skill 名称必须使用小写字母、数字和连字符')
      const skill = await skills.get(args.name, exec.workingDirectory, exec.signal)
      if (!skill) throw new Error(`Skill "${args.name}" 不存在或不可用`)
      if (!skill.invocation.modelInvocable) throw new Error(`Skill "${args.name}" 不允许模型调用`)
      return { name: skill.name, provider: skill.provider, resourceBase: skill.resourceBase, content: skill.content }
    },
  })
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}
