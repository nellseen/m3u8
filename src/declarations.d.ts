declare module 'input' {
  const input: {
    text: (message: string, options?: any) => Promise<string>;
    password: (message: string, options?: any) => Promise<string>;
    confirm: (message: string, options?: any) => Promise<boolean>;
    select: (message: string, choices: string[], options?: any) => Promise<string>;
  };
  export default input;
}
