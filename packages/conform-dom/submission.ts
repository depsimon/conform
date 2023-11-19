import type { FormValue } from './form';
import { requestSubmit } from './dom';
import {
	simplify,
	flatten,
	isPlainObject,
	setValue,
	isPrefix,
} from './formdata';
import { invariant } from './util';

export type SubmissionState = {
	validated: Record<string, boolean>;
};

export type SubmissionContext<Value> = {
	intent: Intent | null;
	payload: Record<string, unknown>;
	fields: string[];
	value?: Value | null;
	error?: Record<string, string[]>;
	state: SubmissionState;
};

export type Submission<Schema, Value = Schema> =
	| {
			type: 'submit';
			payload: Record<string, unknown>;
			value: Value | null;
			error: Record<string, string[]>;
			reject(options?: RejectOptions): SubmissionResult;
			accept(options?: AcceptOptions): SubmissionResult;
	  }
	| {
			type: 'update';
			payload: Record<string, unknown>;
			value: null;
			error: Record<string, string[]> | null;
			reject(options?: RejectOptions): SubmissionResult;
			accept(options?: AcceptOptions): SubmissionResult;
	  };

export type SubmissionResult = {
	status: 'updated' | 'error' | 'success';
	intent?: Intent;
	initialValue?: Record<string, unknown>;
	error?: Record<string, string[]>;
	state?: SubmissionState;
};

export type AcceptOptions = {
	resetForm?: boolean;
};

export type RejectOptions =
	| {
			formErrors: string[];
			fieldErrors?: Record<string, string[]>;
	  }
	| {
			formErrors?: string[];
			fieldErrors: Record<string, string[]>;
	  };

/**
 * The name to be used when submitting an intent
 */
export const INTENT = '__intent__';

/**
 * The name to be used when submitting a state
 */
export const STATE = '__state__';

export function getSubmissionContext(
	body: FormData | URLSearchParams,
): SubmissionContext<unknown> {
	const intent = body.get(INTENT);
	const state = body.get(STATE);
	const payload: Record<string, unknown> = {};
	const fields: string[] = [];

	invariant(
		(typeof intent === 'string' || intent === null) &&
			(typeof state === 'string' || state === null),
		`The input name "${INTENT}" and "${STATE}" are reserved by Conform. Please use another name for your input.`,
	);

	for (const [name, next] of body.entries()) {
		if (name === INTENT || name === STATE) {
			continue;
		}

		fields.push(name);
		setValue(payload, name, (prev) => {
			if (!prev) {
				return next;
			} else if (Array.isArray(prev)) {
				return prev.concat(next);
			} else {
				return [prev, next];
			}
		});
	}

	return {
		payload,
		intent: getIntent(intent),
		state: state ? JSON.parse(state) : { validated: {} },
		fields,
	};
}

export function parse<Value>(
	payload: FormData | URLSearchParams,
	options: {
		resolve: (
			payload: Record<string, any>,
			intent: string,
		) => { value?: Value; error?: Record<string, string[]> };
	},
): Submission<Value>;
export function parse<Value>(
	payload: FormData | URLSearchParams,
	options: {
		resolve: (
			payload: Record<string, any>,
			intent: string,
		) => Promise<{ value?: Value; error?: Record<string, string[]> }>;
	},
): Promise<Submission<Value>>;
export function parse<Value>(
	payload: FormData | URLSearchParams,
	options: {
		resolve: (
			payload: Record<string, any>,
			intent: string,
		) =>
			| { value?: Value; error?: Record<string, string[]> }
			| Promise<{ value?: Value; error?: Record<string, string[]> }>;
	},
): Submission<Value> | Promise<Submission<Value>>;
export function parse<Value>(
	payload: FormData | URLSearchParams,
	options: {
		resolve: (
			payload: Record<string, any>,
			intent: string,
		) =>
			| { value?: Value; error?: Record<string, string[]> }
			| Promise<{ value?: Value; error?: Record<string, string[]> }>;
	},
): Submission<Value> | Promise<Submission<Value>> {
	const context = getSubmissionContext(payload);

	if (context.intent) {
		switch (context.intent.type) {
			case 'validate':
				context.state.validated[context.intent.payload] = true;
				break;
			case 'reset': {
				if (context.intent.payload.name) {
					setValue(
						context.payload,
						context.intent.payload.name,
						() => undefined,
					);

					if (!context.intent.payload.validated) {
						setState(
							context.state.validated,
							context.intent.payload.name,
							() => undefined,
						);

						delete context.state.validated[context.intent.payload.name];
					}
				} else {
					context.payload = {};

					if (!context.intent.payload.validated) {
						context.state.validated = {};
					}
				}
				break;
			}
			case 'list': {
				setListValue(context.payload, context.intent.payload);
				setListState(context.state.validated, context.intent.payload);

				context.state.validated[context.intent.payload.name] = true;
				break;
			}
		}
	}

	const result = options.resolve(
		context.payload,
		context.intent === null
			? 'submit'
			: `${context.intent.type}/${
					context.intent.type === 'validate'
						? context.intent.payload
						: JSON.stringify(context.intent.payload)
			  }`,
	);
	const mergeResolveResult = (resolved: {
		error?: Record<string, string[]>;
		value?: Value;
	}): Submission<Value> => {
		const error = resolved.error ?? {};

		if (!context.intent) {
			for (const name of [...context.fields, ...Object.keys(error)]) {
				context.state.validated[name] = true;
			}
		}

		return createSubmission({
			...context,
			value: resolved.value ?? null,
			error,
		});
	};

	if (result instanceof Promise) {
		return result.then(mergeResolveResult);
	}

	return mergeResolveResult(result);
}

export function createSubmission<Value>(
	context: Required<SubmissionContext<Value>>,
): Submission<Value> {
	if (context.intent !== null) {
		return {
			type: 'update',
			payload: context.payload,
			value: null,
			error: context.error ?? {},
			accept(options) {
				return acceptSubmission(context, options);
			},
			reject(options) {
				return rejectSubmission(context, options);
			},
		};
	}

	return {
		type: 'submit',
		payload: context.payload,
		value: context.value,
		error: context.error,
		accept(options) {
			return acceptSubmission(context, options);
		},
		reject(options) {
			return rejectSubmission(context, options);
		},
	};
}

export function acceptSubmission(
	context: Required<SubmissionContext<unknown>>,
	options?: AcceptOptions,
): SubmissionResult {
	if (options?.resetForm) {
		return { status: 'success' };
	}

	return {
		status: 'success',
		initialValue: simplify(context.payload) ?? {},
		error: simplify(context.error) as Record<string, string[]>,
		state: context.state,
	};
}

export function rejectSubmission(
	context: Required<SubmissionContext<unknown>>,
	options?: RejectOptions,
): SubmissionResult {
	const error = Object.entries(context.error ?? {}).reduce<
		Record<string, string[]>
	>(
		(result, [name, messages]) => {
			if (messages.length > 0 && context.state.validated[name]) {
				result[name] = (result[name] ?? []).concat(messages);
			}

			return result;
		},
		{ '': options?.formErrors ?? [], ...options?.fieldErrors },
	);

	return {
		status: context.intent !== null ? 'updated' : 'error',
		intent: context.intent !== null ? context.intent : undefined,
		initialValue: simplify(context.payload) ?? {},
		error: simplify(error) as Record<string, string[]>,
		state: context.state,
	};
}

export type Intent =
	| {
			type: 'validate';
			payload: string;
	  }
	| {
			type: 'list';
			payload: ListIntentPayload;
	  }
	| {
			type: 'reset';
			payload: {
				name?: string;
				validated?: boolean;
			};
	  };

export type ListIntentPayload<Schema = unknown> =
	| { name: string; operation: 'insert'; defaultValue?: Schema; index?: number }
	| { name: string; operation: 'prepend'; defaultValue?: FormValue<Schema> }
	| { name: string; operation: 'append'; defaultValue?: FormValue<Schema> }
	| {
			name: string;
			operation: 'replace';
			defaultValue: FormValue<Schema>;
			index: number;
	  }
	| { name: string; operation: 'remove'; index: number }
	| { name: string; operation: 'reorder'; from: number; to: number };

export function getIntent(intent: string | null | undefined): Intent | null {
	if (!intent) {
		return null;
	}

	const { type, payload } = JSON.parse(intent);

	switch (type) {
		case 'validate':
		case 'reset':
		case 'list':
			return { type, payload };
	}

	throw new Error('Unknown intent');
}

export function serializeIntent(intent: Intent): string {
	return JSON.stringify(intent);
}

export function requestIntent(
	form: HTMLFormElement | null | undefined,
	value: string,
): void {
	const submitter = document.createElement('button');

	submitter.name = INTENT;
	submitter.value = value;
	submitter.hidden = true;
	submitter.formNoValidate = true;

	requestSubmit(form, submitter);
}

export function updateList(list: unknown, payload: ListIntentPayload): void {
	invariant(
		Array.isArray(list),
		`Failed to update list. The value is not an array.`,
	);

	switch (payload.operation) {
		case 'prepend':
			list.unshift(payload.defaultValue as any);
			break;
		case 'append':
			list.push(payload.defaultValue as any);
			break;
		case 'insert':
			list.splice(payload.index ?? list.length, 0, payload.defaultValue as any);
			break;
		case 'replace':
			list.splice(payload.index, 1, payload.defaultValue);
			break;
		case 'remove':
			list.splice(payload.index, 1);
			break;
		case 'reorder':
			list.splice(payload.to, 0, ...list.splice(payload.from, 1));
			break;
		default:
			throw new Error('Unknown list intent received');
	}
}

export function setListValue(
	data: Record<string, unknown>,
	payload: ListIntentPayload,
): void {
	setValue(data, payload.name, (value) => {
		const list = value ?? [];

		updateList(list, payload);

		return list;
	});
}

export function setState(
	state: Record<string, unknown>,
	name: string,
	valueFn: (value: unknown) => unknown,
): void {
	const root = Symbol.for('root');

	// The keys are sorted in desc so that the root value is handled last
	const keys = Object.keys(state).sort((prev, next) =>
		next.localeCompare(prev),
	);
	const target: Record<string, unknown> = {};

	for (const key of keys) {
		const value = state[key];

		if (isPrefix(key, name) && key !== name) {
			setValue(target, key, (currentValue) => {
				if (typeof currentValue === 'undefined') {
					return value;
				}

				// As the key should be unique, if currentValue is already defined,
				// it must be either an object or an array

				// @ts-expect-error
				currentValue[root] = value;

				return currentValue;
			});

			// Remove the value from the data
			delete state[key];
		}
	}

	let result;

	setValue(target, name, (currentValue) => {
		result = valueFn(currentValue);

		return result;
	});

	Object.assign(
		state,
		flatten(result, {
			resolve(data) {
				if (isPlainObject(data) || Array.isArray(data)) {
					// @ts-expect-error
					return data[root] ?? null;
				}

				return data;
			},
			prefix: name,
		}),
	);
}

export function setListState(
	state: Record<string, unknown>,
	payload: ListIntentPayload,
	getDefaultValue?: () => unknown,
): void {
	setState(state, payload.name, (value) => {
		const list = value ?? [];

		switch (payload.operation) {
			case 'append':
			case 'prepend':
			case 'insert':
			case 'replace':
				updateList(list, {
					...payload,
					defaultValue: getDefaultValue?.(),
				});
				break;
			default:
				updateList(list, payload);
				break;
		}

		return list;
	});
}
