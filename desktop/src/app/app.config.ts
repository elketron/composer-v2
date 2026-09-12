import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { RouteReuseStrategy, provideRouter, withComponentInputBinding, withHashLocation } from '@angular/router';

import { routes } from './app.routes';
import { ProjectTabReuseStrategy } from './shell/project-tab-reuse';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Hash location: the packaged app loads index.html from file://, where the
    // HTML5 history API does not survive reloads. Route params bind to
    // component inputs (the run view's cardId).
    provideRouter(routes, withHashLocation(), withComponentInputBinding()),
    // Open projects keep their views alive across tab switches.
    { provide: RouteReuseStrategy, useClass: ProjectTabReuseStrategy },
  ],
};
