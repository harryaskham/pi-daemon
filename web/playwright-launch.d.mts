/** Environment variable that opts an environment out of the browser sandbox. */
export declare const NO_SANDBOX_ENV: string;

/** Arguments applied only when an environment has opted out of the sandbox. */
export declare const NO_SANDBOX_ARGS: string[];

/** Launch options for the audited browser, honouring the opt-out variable. */
export declare function browserLaunchOptions(env?: NodeJS.ProcessEnv): {
  args?: string[];
};
