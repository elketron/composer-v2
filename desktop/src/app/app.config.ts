import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withHashLocation } from '@angular/router';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Hash location: the packaged app loads index.html from file://, where the
    // HTML5 history API does not survive reloads.
    provideRouter(routes, withHashLocation()),
  ],
};
