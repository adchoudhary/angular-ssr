import {Provider} from '@angular/core';

import {toTypeScript} from '@angular/compiler';

import {MetadataWriterHost} from '@angular/tsc-wrapped';

import {CompilerHost as AngularCompilerHost} from '@angular/compiler-cli';

import {
  CompilerHost,
  Program,
  SourceFile,
  createCompilerHost,
  createProgram,
} from 'typescript';

import {join, relative} from 'path';

import {
  PathReference,
  makeAbsolute,
  pathFromString,
} from '../../../filesystem';

import {ApplicationCompiler} from '../compiler';
import {Build} from './build';
import {ModuleLoader} from '../loader';
import {NgcModuleLoader} from './loader';
import {Project} from '../../project';
import {ServerPlatform, createStaticPlatform} from '../../../platform';
import {assertDiagnostics, assertProgram} from './diagnostics';
import {createNgCompiler} from './create';
import {projectToOptions, loadApplicationModule} from '../options';

export class NgcCompiler implements ApplicationCompiler {
  constructor(private project: Project) {}

  createPlatform(providers: Array<Provider>): ServerPlatform {
    return createStaticPlatform(providers) as any;
  }

  async compile(): Promise<ModuleLoader> {
    return new NgcModuleLoader(this.project, await this.loadAndCompile());
  }

  private roots(program: Program): Array<PathReference> {
    const options = program.getCompilerOptions();

    const candidates = [options.rootDir].concat(options.rootDirs || []).filter(v => v);

    return candidates.map(c => pathFromString(makeAbsolute(this.project.basePath, c)));
  }

  private async loadAndCompile(): Promise<Build> {
    const {ts, ng, sources} = projectToOptions(this.project);

    const compilerHost = createCompilerHost(ts, false);

    const program = createProgram(sources, ts, compilerHost);

    assertProgram(program);

    this.project.applicationModule = loadApplicationModule(
      program,
      this.project.basePath,
      this.project.applicationModule);

    const roots = this.roots(program);

    const relativeOutput = relative(this.project.basePath.toString(), ts.outDir);

    const workingPath = this.project.workingPath || process.cwd();

    const outputs = [
      ts.outDir,
      join(this.project.workingPath.toString(), relativeOutput),
      workingPath
    ].map(pathFromString);

    if (this.project.workingPath != null) {
      ts.outDir = join(this.project.workingPath.toString(), relativeOutput);
      ng.outDir = ts.outDir;
    }

    const build = new Build(this.project.basePath, outputs, roots);

    const {host, compiler} = createNgCompiler(compilerHost, program, ng, roots);

    const generatedModules = await this.generateTemplateCode(compilerHost, host, compiler, program, build);

    const metadataWriter = new MetadataWriterHost(compilerHost, ng, true);

    const canonicalSources = program.getSourceFiles().map(sf => sf.fileName).concat(generatedModules);

    const templatedProgram = createProgram(canonicalSources, ts, metadataWriter, program);

    const originalWriteFile = compilerHost.writeFile.bind(compilerHost);

    const writeFile = (filename: string, data: string, writeByteOrderMark: boolean, onError: (message: string) => void, sourceFiles: Array<SourceFile>) => {
      build.emit(filename, sourceFiles);

      return originalWriteFile(filename, data, writeByteOrderMark, onError, sourceFiles);
    };

    const emitResult = templatedProgram.emit(undefined, writeFile);
    if (emitResult) {
      assertDiagnostics(emitResult.diagnostics);
    }

    return build;
  }

  private async generateTemplateCode(compilerHost: CompilerHost, ngCompilerHost: AngularCompilerHost, compiler, program: Program, build: Build) {
    const filenames = program.getSourceFiles().map(sf => ngCompilerHost.getCanonicalFileName(sf.fileName));

    const analyzedModules = await compiler.analyzeModulesAsync(filenames);

    const generatedModules = compiler.emitAllImpls(analyzedModules);

    return generatedModules.map(
      generatedModule => {
        const sourceFile = program.getSourceFile(generatedModule.srcFileUrl);

        const emitPath = ngCompilerHost.calculateEmitPath(generatedModule.genFileUrl);

        const source = generatedModule.source || toTypeScript(generatedModule, String());

        compilerHost.writeFile(emitPath, source, false, function () {}, [sourceFile]);

        build.emit(emitPath, [sourceFile]);

        return emitPath;
      });
  }
}
