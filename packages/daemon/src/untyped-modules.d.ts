// Ambient declarations for CJS packages that ship no types of their own and
// have no `@types/*` package on npm (checked before adding these — see
// docConvert.ts). Each covers only the surface this codebase actually calls.

declare module 'mammoth' {
  export interface MammothMessage {
    type: 'warning' | 'error';
    message: string;
  }
  export interface MammothImageElement {
    contentType: string;
    altText?: string;
    read(encoding: 'base64'): Promise<string>;
  }
  export interface MammothConvertResult {
    value: string;
    messages: MammothMessage[];
  }
  export interface MammothConvertOptions {
    convertImage?: (
      element: MammothImageElement,
      messages: MammothMessage[],
    ) => Promise<Array<{ tag: string; attributes: Record<string, string> }>>;
  }
  interface MammothImagesNamespace {
    imgElement(
      fn: (element: MammothImageElement) => Promise<Record<string, string>>,
    ): MammothConvertOptions['convertImage'];
  }
  const mammoth: {
    convertToHtml(
      input: { path: string } | { buffer: Buffer },
      options?: MammothConvertOptions,
    ): Promise<MammothConvertResult>;
    images: MammothImagesNamespace;
  };
  export default mammoth;
}

declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  const plugin: { gfm: (service: TurndownService) => void };
  export default plugin;
}
