/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/css!./media/textdiffeditor';
import { TPromise } from 'vs/base/common/winjs.base';
import * as nls from 'vs/nls';
import * as objects from 'vs/base/common/objects';
import { Action, IAction } from 'vs/base/common/actions';
import * as types from 'vs/base/common/types';
import { IDiffEditor } from 'vs/editor/browser/editorBrowser';
import { IDiffEditorOptions, IEditorOptions as ICodeEditorOptions } from 'vs/editor/common/config/editorOptions';
import { BaseTextEditor, IEditorConfiguration } from 'vs/workbench/browser/parts/editor/textEditor';
import { TextEditorOptions, EditorInput, EditorOptions, TEXT_DIFF_EDITOR_ID, IEditorInputFactoryRegistry, Extensions as EditorInputExtensions, ITextDiffEditor, IEditorMemento } from 'vs/workbench/common/editor';
import { ResourceEditorInput } from 'vs/workbench/common/editor/resourceEditorInput';
import { DiffEditorInput } from 'vs/workbench/common/editor/diffEditorInput';
import { DiffNavigator } from 'vs/editor/browser/widget/diffNavigator';
import { DiffEditorWidget } from 'vs/editor/browser/widget/diffEditorWidget';
import { TextDiffEditorModel } from 'vs/workbench/common/editor/textDiffEditorModel';
import { FileOperationError, FileOperationResult } from 'vs/platform/files/common/files';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { ITextResourceConfigurationService } from 'vs/editor/common/services/resourceConfiguration';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';
import { ScrollType, IDiffEditorViewState, IDiffEditorModel } from 'vs/editor/common/editorCommon';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { Registry } from 'vs/platform/registry/common/platform';
import URI from 'vs/base/common/uri';
import { once } from 'vs/base/common/event';
import { IEditorGroupsService } from 'vs/workbench/services/group/common/editorGroupsService';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { CancellationToken } from 'vs/base/common/cancellation';
import { EditorMemento } from 'vs/workbench/browser/parts/editor/baseEditor';

/**
 * The text editor that leverages the diff text editor for the editing experience.
 */
export class TextDiffEditor extends BaseTextEditor implements ITextDiffEditor {

	public static readonly ID = TEXT_DIFF_EDITOR_ID;

	private diffNavigator: DiffNavigator;
	private diffNavigatorDisposables: IDisposable[] = [];
	private nextDiffAction: NavigateAction;
	private previousDiffAction: NavigateAction;
	private toggleIgnoreTrimWhitespaceAction: ToggleIgnoreTrimWhitespaceAction;

	constructor(
		@ITelemetryService telemetryService: ITelemetryService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IStorageService storageService: IStorageService,
		@ITextResourceConfigurationService configurationService: ITextResourceConfigurationService,
		@IConfigurationService private readonly _actualConfigurationService: IConfigurationService,
		@IEditorService editorService: IEditorService,
		@IThemeService themeService: IThemeService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@ITextFileService textFileService: ITextFileService,
	) {
		super(TextDiffEditor.ID, telemetryService, instantiationService, storageService, configurationService, themeService, textFileService, editorService, editorGroupService);

		this.toUnbind.push(this._actualConfigurationService.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('diffEditor.ignoreTrimWhitespace')) {
				this.updateIgnoreTrimWhitespaceAction();
			}
		}));
	}

	protected getEditorMemento<T>(storageService: IStorageService, editorGroupService: IEditorGroupsService, key: string, limit: number = 10): IEditorMemento<T> {
		return new EditorMemento(this.getId(), key, Object.create(null), limit, editorGroupService); // do not persist in storage as diff editors are never persisted
	}

	public getTitle(): string {
		if (this.input) {
			return this.input.getName();
		}

		return nls.localize('textDiffEditor', "Text Diff Editor");
	}

	public createEditorControl(parent: HTMLElement, configuration: ICodeEditorOptions): IDiffEditor {

		// Actions
		this.nextDiffAction = new NavigateAction(this, true);
		this.previousDiffAction = new NavigateAction(this, false);
		this.toggleIgnoreTrimWhitespaceAction = new ToggleIgnoreTrimWhitespaceAction(this._actualConfigurationService);
		this.updateIgnoreTrimWhitespaceAction();

		return this.instantiationService.createInstance(DiffEditorWidget, parent, configuration);
	}

	public setInput(input: EditorInput, options: EditorOptions, token: CancellationToken): Thenable<void> {

		// Dispose previous diff navigator
		this.diffNavigatorDisposables = dispose(this.diffNavigatorDisposables);

		// Remember view settings if input changes
		this.saveTextDiffEditorViewState(this.input);

		// Set input and resolve
		return super.setInput(input, options, token).then(() => {
			return input.resolve(true).then(resolvedModel => {

				// Check for cancellation
				if (token.isCancellationRequested) {
					return void 0;
				}

				// Assert Model Instance
				if (!(resolvedModel instanceof TextDiffEditorModel) && this.openAsBinary(input, options)) {
					return void 0;
				}

				// Set Editor Model
				const diffEditor = this.getControl();
				diffEditor.setModel((<TextDiffEditorModel>resolvedModel).textDiffEditorModel);

				// Apply Options from TextOptions
				let optionsGotApplied = false;
				if (options && types.isFunction((<TextEditorOptions>options).apply)) {
					optionsGotApplied = (<TextEditorOptions>options).apply(diffEditor, ScrollType.Immediate);
				}

				// Otherwise restore View State
				let hasPreviousViewState = false;
				if (!optionsGotApplied) {
					hasPreviousViewState = this.restoreTextDiffEditorViewState(input);
				}

				this.diffNavigator = new DiffNavigator(diffEditor, {
					alwaysRevealFirst: !optionsGotApplied && !hasPreviousViewState // only reveal first change if we had no options or viewstate
				});
				this.diffNavigatorDisposables.push(this.diffNavigator);

				this.diffNavigatorDisposables.push(this.diffNavigator.onDidUpdate(() => {
					this.nextDiffAction.updateEnablement();
					this.previousDiffAction.updateEnablement();
				}));

				this.updateIgnoreTrimWhitespaceAction();
			}, error => {

				// In case we tried to open a file and the response indicates that this is not a text file, fallback to binary diff.
				if (this.isFileBinaryError(error) && this.openAsBinary(input, options)) {
					return null;
				}

				// Otherwise make sure the error bubbles up
				return TPromise.wrapError(error);
			});
		});
	}

	public setOptions(options: EditorOptions): void {
		const textOptions = <TextEditorOptions>options;
		if (textOptions && types.isFunction(textOptions.apply)) {
			textOptions.apply(this.getControl(), ScrollType.Smooth);
		}
	}

	private restoreTextDiffEditorViewState(input: EditorInput): boolean {
		if (input instanceof DiffEditorInput) {
			const resource = this.toDiffEditorViewStateResource(input);
			if (resource) {
				const viewState = this.loadTextEditorViewState(resource);
				if (viewState) {
					this.getControl().restoreViewState(viewState);

					return true;
				}
			}
		}

		return false;
	}

	private updateIgnoreTrimWhitespaceAction(): void {
		const ignoreTrimWhitespace = this.configurationService.getValue<boolean>(this.getResource(), 'diffEditor.ignoreTrimWhitespace');
		if (this.toggleIgnoreTrimWhitespaceAction) {
			this.toggleIgnoreTrimWhitespaceAction.updateClassName(ignoreTrimWhitespace);
		}
	}

	private openAsBinary(input: EditorInput, options: EditorOptions): boolean {
		if (input instanceof DiffEditorInput) {
			const originalInput = input.originalInput;
			const modifiedInput = input.modifiedInput;

			const binaryDiffInput = new DiffEditorInput(input.getName(), input.getDescription(), originalInput, modifiedInput, true);

			// Forward binary flag to input if supported
			const fileInputFactory = Registry.as<IEditorInputFactoryRegistry>(EditorInputExtensions.EditorInputFactories).getFileInputFactory();
			if (fileInputFactory.isFileInput(originalInput)) {
				originalInput.setForceOpenAsBinary();
			}

			if (fileInputFactory.isFileInput(modifiedInput)) {
				modifiedInput.setForceOpenAsBinary();
			}

			this.editorService.openEditor(binaryDiffInput, options, this.group);

			return true;
		}

		return false;
	}

	protected computeConfiguration(configuration: IEditorConfiguration): ICodeEditorOptions {
		const editorConfiguration = super.computeConfiguration(configuration);

		// Handle diff editor specially by merging in diffEditor configuration
		if (types.isObject(configuration.diffEditor)) {
			objects.mixin(editorConfiguration, configuration.diffEditor);
		}

		return editorConfiguration;
	}

	protected getConfigurationOverrides(): ICodeEditorOptions {
		const options: IDiffEditorOptions = super.getConfigurationOverrides();

		options.readOnly = this.isReadOnly();

		return options;
	}

	protected getAriaLabel(): string {
		let ariaLabel: string;
		const inputName = this.input && this.input.getName();
		if (this.isReadOnly()) {
			ariaLabel = inputName ? nls.localize('readonlyEditorWithInputAriaLabel', "{0}. Readonly text compare editor.", inputName) : nls.localize('readonlyEditorAriaLabel', "Readonly text compare editor.");
		} else {
			ariaLabel = inputName ? nls.localize('editableEditorWithInputAriaLabel', "{0}. Text file compare editor.", inputName) : nls.localize('editableEditorAriaLabel', "Text file compare editor.");
		}

		return ariaLabel;
	}

	private isReadOnly(): boolean {
		const input = this.input;
		if (input instanceof DiffEditorInput) {
			const modifiedInput = input.modifiedInput;

			return modifiedInput instanceof ResourceEditorInput;
		}

		return false;
	}

	private isFileBinaryError(error: Error[]): boolean;
	private isFileBinaryError(error: Error): boolean;
	private isFileBinaryError(error: any): boolean {
		if (types.isArray(error)) {
			const errors = <Error[]>error;
			return errors.some(e => this.isFileBinaryError(e));
		}

		return (<FileOperationError>error).fileOperationResult === FileOperationResult.FILE_IS_BINARY;
	}

	public clearInput(): void {

		// Dispose previous diff navigator
		this.diffNavigatorDisposables = dispose(this.diffNavigatorDisposables);

		// Keep editor view state in settings to restore when coming back
		this.saveTextDiffEditorViewState(this.input);

		// Clear Model
		this.getControl().setModel(null);

		// Pass to super
		super.clearInput();
	}

	public getDiffNavigator(): DiffNavigator {
		return this.diffNavigator;
	}

	public getActions(): IAction[] {
		return [
			this.toggleIgnoreTrimWhitespaceAction,
			this.previousDiffAction,
			this.nextDiffAction
		];
	}

	public getControl(): IDiffEditor {
		return super.getControl() as IDiffEditor;
	}

	protected loadTextEditorViewState(resource: URI): IDiffEditorViewState {
		return super.loadTextEditorViewState(resource) as IDiffEditorViewState;  // overridden for text diff editor support
	}

	private saveTextDiffEditorViewState(input: EditorInput): void {
		if (!(input instanceof DiffEditorInput)) {
			return; // only supported for diff editor inputs
		}

		const resource = this.toDiffEditorViewStateResource(input);
		if (!resource) {
			return; // unable to retrieve input resource
		}

		// Clear view state if input is disposed
		if (input.isDisposed()) {
			super.clearTextEditorViewState([resource]);
		}

		// Otherwise save it
		else {
			super.saveTextEditorViewState(resource);

			// Make sure to clean up when the input gets disposed
			once(input.onDispose)(() => {
				super.clearTextEditorViewState([resource]);
			});
		}
	}

	protected retrieveTextEditorViewState(resource: URI): IDiffEditorViewState {
		return this.retrieveTextDiffEditorViewState(resource); // overridden for text diff editor support
	}

	private retrieveTextDiffEditorViewState(resource: URI): IDiffEditorViewState {
		const control = this.getControl();
		const model = control.getModel();
		if (!model || !model.modified || !model.original) {
			return null; // view state always needs a model
		}

		const modelUri = this.toDiffEditorViewStateResource(model);
		if (!modelUri) {
			return null; // model URI is needed to make sure we save the view state correctly
		}

		if (modelUri.toString() !== resource.toString()) {
			return null; // prevent saving view state for a model that is not the expected one
		}

		return control.saveViewState();
	}

	private toDiffEditorViewStateResource(modelOrInput: IDiffEditorModel | DiffEditorInput): URI {
		let original: URI;
		let modified: URI;

		if (modelOrInput instanceof DiffEditorInput) {
			original = modelOrInput.originalInput.getResource();
			modified = modelOrInput.modifiedInput.getResource();
		} else {
			original = modelOrInput.original.uri;
			modified = modelOrInput.modified.uri;
		}

		if (!original || !modified) {
			return null;
		}

		// create a URI that is the Base64 concatenation of original + modified resource
		return URI.from({ scheme: 'diff', path: `${btoa(original.toString())}${btoa(modified.toString())}` });
	}

	public dispose(): void {
		this.diffNavigatorDisposables = dispose(this.diffNavigatorDisposables);

		super.dispose();
	}
}

class NavigateAction extends Action {
	static ID_NEXT = 'workbench.action.compareEditor.nextChange';
	static ID_PREV = 'workbench.action.compareEditor.previousChange';

	private editor: TextDiffEditor;
	private next: boolean;

	constructor(editor: TextDiffEditor, next: boolean) {
		super(next ? NavigateAction.ID_NEXT : NavigateAction.ID_PREV);

		this.editor = editor;
		this.next = next;

		this.label = this.next ? nls.localize('navigate.next.label', "Next Change") : nls.localize('navigate.prev.label', "Previous Change");
		this.class = this.next ? 'textdiff-editor-action next' : 'textdiff-editor-action previous';
		this.enabled = false;
	}

	public run(): TPromise<any> {
		if (this.next) {
			this.editor.getDiffNavigator().next();
		} else {
			this.editor.getDiffNavigator().previous();
		}

		return null;
	}

	public updateEnablement(): void {
		this.enabled = this.editor.getDiffNavigator().canNavigate();
	}
}

class ToggleIgnoreTrimWhitespaceAction extends Action {
	static ID = 'workbench.action.compareEditor.toggleIgnoreTrimWhitespace';

	private _isChecked: boolean;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService
	) {
		super(ToggleIgnoreTrimWhitespaceAction.ID);
		this.label = nls.localize('toggleIgnoreTrimWhitespace.label', "Ignore Trim Whitespace");
	}

	public updateClassName(ignoreTrimWhitespace: boolean): void {
		this._isChecked = ignoreTrimWhitespace;
		this.class = `textdiff-editor-action toggleIgnoreTrimWhitespace${this._isChecked ? ' is-checked' : ''}`;
	}

	public run(): TPromise<any> {
		this._configurationService.updateValue(`diffEditor.ignoreTrimWhitespace`, !this._isChecked);
		return null;
	}
}
