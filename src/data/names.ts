import type { Side } from '@/shared/types';
import type { Rng } from '@/shared/rng';

/** Leader ranks first (most senior first) per side. */
export const RANKS: Record<Side, string[]> = {
  german: ['Lt', 'Fw', 'Uffz', 'OGefr', 'Gefr', 'Schtz'],
  soviet: ['Lt', 'StSzh', 'Serzh', 'MlSzh', 'Efr', 'Ryad'],
};

const GERMAN_SURNAMES: string[] = [
  'Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker',
  'Schulz', 'Hoffmann', 'Schäfer', 'Koch', 'Bauer', 'Richter', 'Klein', 'Wolf',
  'Schröder', 'Neumann', 'Schwarz', 'Zimmermann', 'Braun', 'Krüger', 'Hofmann', 'Hartmann',
  'Lange', 'Schmitt', 'Werner', 'Schmitz', 'Krause', 'Meier', 'Lehmann', 'Schmid',
  'Schulze', 'Maier', 'Köhler', 'Herrmann', 'König', 'Walter', 'Mayer', 'Huber',
  'Kaiser', 'Fuchs', 'Peters', 'Lang', 'Scholz', 'Möller', 'Weiß', 'Jung',
  'Hahn', 'Schubert', 'Vogel', 'Friedrich', 'Keller', 'Günther', 'Frank', 'Berger',
  'Winkler', 'Roth', 'Beck', 'Lorenz', 'Baumann', 'Franke', 'Albrecht', 'Schuster',
  'Simon', 'Ludwig', 'Böhm', 'Winter', 'Kraus', 'Martin', 'Schumacher', 'Krämer',
  'Vogt', 'Stein', 'Jäger', 'Otto', 'Sommer', 'Groß', 'Seidel', 'Heinrich',
  'Brandt', 'Haas', 'Schreiber', 'Graf', 'Schulte', 'Dietrich', 'Ziegler', 'Kuhn',
];

const RUSSIAN_SURNAMES: string[] = [
  'Ivanov', 'Smirnov', 'Kuznetsov', 'Popov', 'Vasiliev', 'Petrov', 'Sokolov', 'Mikhailov',
  'Novikov', 'Fedorov', 'Morozov', 'Volkov', 'Alexeev', 'Lebedev', 'Semenov', 'Egorov',
  'Pavlov', 'Kozlov', 'Stepanov', 'Nikolaev', 'Orlov', 'Andreev', 'Makarov', 'Nikitin',
  'Zakharov', 'Zaitsev', 'Solovyov', 'Borisov', 'Yakovlev', 'Grigoriev', 'Romanov', 'Vorobyov',
  'Sergeev', 'Kuzmin', 'Frolov', 'Alexandrov', 'Dmitriev', 'Korolev', 'Gusev', 'Kiselev',
  'Ilyin', 'Maximov', 'Polyakov', 'Sorokin', 'Vinogradov', 'Kovalev', 'Belov', 'Medvedev',
  'Antonov', 'Tarasov', 'Zhukov', 'Bakanov', 'Filippov', 'Davydov', 'Melnikov', 'Shcherbakov',
  'Blinov', 'Kolesnikov', 'Karpov', 'Afanasyev', 'Vlasov', 'Mamontov', 'Panov', 'Rybakov',
  'Kudryavtsev', 'Osipov', 'Isaev', 'Ponomarev', 'Golubev', 'Bogdanov', 'Vorontsov', 'Shubin',
  'Nazarov', 'Belyaev', 'Kalinin', 'Timofeev', 'Guryev', 'Chernov', 'Larionov', 'Zimin',
  'Bulanov', 'Simonov', 'Yudin', 'Krylov',
];

export function randomName(side: Side, rng: Rng): string {
  return rng.pick(side === 'german' ? GERMAN_SURNAMES : RUSSIAN_SURNAMES);
}
